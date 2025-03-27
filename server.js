import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import { GoogleAuth } from "google-auth-library";
import { v2 } from "@google-cloud/translate";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { promisify } from "util";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, doc, setDoc, getDoc, updateDoc, arrayUnion } from "firebase/firestore";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const requiredEnvVars = [
  "FIREBASE_API_KEY",
  "FIREBASE_AUTH_DOMAIN",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_STORAGE_BUCKET",
  "FIREBASE_MESSAGING_SENDER_ID",
  "FIREBASE_APP_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_PLACES_API_KEY",
  "GOOGLE_VISION_API_KEY",
  "LINE_ACCESS_TOKEN",
  "PROJECT_ID",
  "GOOGLE_CUSTOM_SEARCH_API_KEY",
  "GOOGLE_CUSTOM_SEARCH_ENGINE_ID",
];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing environment variable: ${envVar}`);
    process.exit(1);
  }
}

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
};
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
console.log("✅ Firebase initialized successfully");

const ensureTempFolder = () => {
  const tempDir = path.join(__dirname, "./temp");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
};
ensureTempFolder();

const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.resolve(__dirname, "./config/vertex-ai-key.json");
const auth = new GoogleAuth({ keyFilename: keyPath, scopes: "https://www.googleapis.com/auth/cloud-platform" });
const translate = new v2.Translate({ keyFilename: keyPath });

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY;
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const GOOGLE_CUSTOM_SEARCH_API_KEY = process.env.GOOGLE_CUSTOM_SEARCH_API_KEY;
const GOOGLE_CUSTOM_SEARCH_ENGINE_ID = process.env.GOOGLE_CUSTOM_SEARCH_ENGINE_ID;

const modelName = process.env.GEMINI_MODEL || "gemini-2.0-flash-001";
console.log(`🚀 Tripster ใช้โมเดล: ${modelName}`);

const getAccessToken = async () => {
  try {
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    return token.token;
  } catch (error) {
    console.error("❌ Error fetching Vertex AI token:", error.message);
    return null;
  }
};

const getAIResponse = async (userId, userMessage, previousMessages = []) => {
  const accessToken = await getAccessToken();
  if (!accessToken) return "ระบบขัดข้อง กรุณาลองใหม่ภายหลัง";

  try {
    const userDocRef = doc(db, "chatHistory", userId);
    const userDoc = await getDoc(userDocRef);
    let chatHistory = previousMessages;

    if (userDoc.exists()) {
      chatHistory = userDoc.data().messages || [];
      if (chatHistory.length > 10) {
        chatHistory = chatHistory.slice(-10);
      }
    }

    const tonePrompt = `
    คุณคือ Tripster เป็นผู้ชาย, ผู้ช่วยด้านการท่องเที่ยวภาคเหนือของประเทศไทย.
    ตอบให้สั้น เข้าใจง่าย ใช้ภาษาสุภาพ เหมาะกับทุกเพศทุกวัย และตอบตามข้อเท็จจริง.
    ใช้ประวัติการสนทนาก่อนหน้าเพื่อปรับคำแนะนำตามความชอบของผู้ใช้.
    หากไม่มีข้อมูลเพียงพอ ให้แนะนำสถานที่ยอดนิยมในภาคเหนือของประเทศไทยและแจ้งว่าเป็นข้อมูลทั่วไป.
  `;

    const messages = [
      ...chatHistory,
      { role: "user", parts: [{ text: `${tonePrompt}\n\nคำถามของผู้ใช้: ${userMessage}` }] },
    ];

    const response = await axios.post(
      `https://us-central1-aiplatform.googleapis.com/v1/projects/${process.env.PROJECT_ID}/locations/us-central1/publishers/google/models/${modelName}:generateContent`,
      { contents: messages },
      { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
    );

    const aiResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "ขออภัย ฉันไม่สามารถให้ข้อมูลได้";

    await setDoc(userDocRef, {
      messages: arrayUnion(...messages, { role: "model", parts: [{ text: aiResponse }] }),
      lastUpdated: new Date(),
    }, { merge: true });

    return aiResponse;
  } catch (error) {
    console.error("❌ Vertex AI error:", error.response?.data || error.message);
    return "ระบบมีปัญหา กรุณาลองใหม่";
  }
};

const translateText = async (text, targetLang = null) => {
  if (typeof text !== "string") {
    console.error(`❌ translateText: Input text is not a string: ${JSON.stringify(text)}`);
    return { text: text?.toString() || "ข้อความไม่ถูกต้อง", lang: "th" };
  }

  try {
    const [detection] = await translate.detect(text);
    const sourceLang = detection.language;
    if (!targetLang || targetLang === sourceLang) return { text, lang: sourceLang };

    const [translation] = await translate.translate(text, targetLang);
    return { text: translation, lang: targetLang };
  } catch (error) {
    console.error("❌ Translation error:", error.message);
    return { text, lang: "th" };
  }
};

const getLocationFromGooglePlaces = async (placeName, type = "tourist_attraction") => {
  const cleanPlaceName = placeName.trim().replace(/\*\*/g, "").split(":")[0];
  const northernProvinces = ["เชียงใหม่", "เชียงราย", "ลำปาง", "ลำพูน", "แม่ฮ่องสอน", "น่าน", "พะเยา", "แพร่", "อุตรดิตถ์"];
  const isNorthern = northernProvinces.some(province => cleanPlaceName.toLowerCase().includes(province.toLowerCase()));
  const searchQuery = isNorthern ? cleanPlaceName : `${cleanPlaceName} ภาคเหนือ Thailand`;
  console.log(`🔍 Searching Google Places for: ${searchQuery}`);

  try {
    const endpoint = "https://maps.googleapis.com/maps/api/place/textsearch/json";
    const params = {
      query: searchQuery,
      fields: "place_id,geometry,formatted_address,name,photos,rating,user_ratings_total",
      key: GOOGLE_PLACES_API_KEY,
      type: type,
    };

    const response = await axios.get(endpoint, { params });

    const candidates = response.data.results;

    if (candidates && candidates.length > 0) {
      const filteredCandidates = candidates
        .filter(candidate => candidate.geometry)
        .sort((a, b) => (b.rating || 0) - (a.rating || 0) || (b.user_ratings_total || 0) - (a.user_ratings_total || 0));

      if (filteredCandidates.length > 0) {
        const place = filteredCandidates[0];
        const photoReference = place.photos && place.photos[0] ? place.photos[0].photo_reference : null;
        console.log(`✅ Found location from Google: ${place.name} (Rating: ${place.rating || "N/A"}, Reviews: ${place.user_ratings_total || "N/A"})`);
        return {
          placeId: place.place_id,
          name: place.name,
          latitude: place.geometry.location.lat,
          longitude: place.geometry.location.lng,
          address: place.formatted_address || "ไม่มีข้อมูลที่อยู่",
          photoReference: photoReference,
          rating: place.rating || "N/A",
          userRatingsTotal: place.user_ratings_total || 0,
        };
      }
    }
    console.warn(`⚠️ No valid location found for: ${searchQuery}`);
    return null;
  } catch (error) {
    console.error("❌ Google Places API error:", error.response?.data?.error_message || error.message);
    return null;
  }
};

const getPlaceDetails = async (placeId) => {
  try {
    const response = await axios.get("https://maps.googleapis.com/maps/api/place/details/json", {
      params: {
        place_id: placeId,
        fields: "name,formatted_address,photo,rating,user_ratings_total,types,website,url,opening_hours",
        key: GOOGLE_PLACES_API_KEY,
      },
    });

    if (response.data.result) {
      const place = response.data.result;
      const photoReference = place.photos && place.photos[0] ? place.photos[0].photo_reference : null;
      return {
        name: place.name,
        address: place.formatted_address,
        photoReference: photoReference,
        rating: place.rating,
        userRatingsTotal: place.user_ratings_total,
        types: place.types,
        website: place.website,
        url: place.url,
        openingHours: place.opening_hours?.weekday_text || "ไม่มีข้อมูล",
      };
    }
    return null;
  } catch (error) {
    console.error("❌ Place Details API error:", error.response?.data?.error_message || error.message);
    return null;
  }
};

// ✅ ปรับปรุงฟังก์ชัน searchPlaceWithCustomSearch
const searchPlaceWithCustomSearch = async (placeName, context = "สถานที่ท่องเที่ยว") => {
  try {
    // ปรับคำค้นหาให้เหมาะสมกับบริบท
    let query = `${placeName} ${context} ภาคเหนือ ประเทศไทย`;
    if (context === "โรงแรม") {
      query = `${placeName} โรงแรม รีวิว ประเทศไทย`; // เน้นคำว่า "โรงแรม" และ "รีวิว"
    }

    console.log(`🔍 Custom Search Query: ${query}`);
    const response = await axios.get("https://www.googleapis.com/customsearch/v1", {
      params: {
        key: GOOGLE_CUSTOM_SEARCH_API_KEY,
        cx: GOOGLE_CUSTOM_SEARCH_ENGINE_ID,
        q: query,
        num: 3, // จำกัดผลลัพธ์ 3 รายการ
        lr: "lang_th", // จำกัดภาษาเป็นไทย
        cr: "countryTH", // จำกัดผลลัพธ์ในประเทศไทย
      },
    });

    if (response.data.items && response.data.items.length > 0) {
      const results = response.data.items
        .filter(item => {
          const text = `${item.title} ${item.snippet}`.toLowerCase();
          return text.includes(placeName.toLowerCase()) && (context === "โรงแรม" ? text.includes("โรงแรม") : true);
        }) // กรองผลลัพธ์ที่เกี่ยวข้อง
        .map(item => ({
          title: item.title,
          link: item.link,
          snippet: item.snippet,
        }));
      console.log(`✅ Found ${results.length} search results for ${placeName} (${context}):`, results.map(r => r.title));
      return results;
    }
    console.warn(`⚠️ No search results found for ${placeName} (${context})`);
    return [];
  } catch (error) {
    console.error("❌ Custom Search API error:", error.response?.data?.error_message || error.message);
    return [];
  }
};

const getHotelsNearPlace = async (placeName) => {
    let searchLocation = await getLocationFromGooglePlaces(placeName);
  
    if (!searchLocation) {
      console.warn(`⚠️ No location found for ${placeName}, using default: Chiang Mai, Thailand`);
      searchLocation = await getLocationFromGooglePlaces("Chiang Mai, Thailand");
      if (!searchLocation) {
        console.warn(`⚠️ No location found for Chiang Mai, using Bangkok, Thailand`);
        searchLocation = await getLocationFromGooglePlaces("Bangkok, Thailand");
      }
    }
  
    if (!searchLocation) {
      console.warn(`⚠️ Using hard-coded coordinates for Chiang Mai as fallback`);
      searchLocation = {
        latitude: 18.7883,
        longitude: 98.9857,
      };
    }
  
    try {
      const response = await axios.get("https://maps.googleapis.com/maps/api/place/nearbysearch/json", {
        params: {
          location: `${searchLocation.latitude},${searchLocation.longitude}`,
          radius: 20000,
          type: "lodging",
          key: GOOGLE_PLACES_API_KEY,
        },
      });
  
      const hotels = response.data.results
        .filter(hotel => hotel.geometry)
        .sort((a, b) => (b.rating || 0) - (a.rating || 0) || (b.user_ratings_total || 0) - (a.user_ratings_total || 0))
        .slice(0, 3)
        .map(hotel => ({
          name: hotel.name,
          address: hotel.vicinity || "ไม่มีข้อมูลที่อยู่",
          photoReference: hotel.photos && hotel.photos[0] ? hotel.photos[0].photo_reference : null,
          latitude: hotel.geometry?.location?.lat || null,
          longitude: hotel.geometry?.location?.lng || null,
          rating: hotel.rating || "N/A",
          userRatingsTotal: hotel.user_ratings_total || 0,
        }));
      console.log(`✅ Found ${hotels.length} hotels near ${placeName}:`, hotels.map(h => h.name));
      return hotels;
    } catch (error) {
      console.error("❌ Nearby Search API error:", error.response?.data?.error_message || error.message);
      return [];
    }
  };

const getPhotoUrl = (photoReference) => {
  if (!photoReference) return "https://example.com/placeholder.jpg";
  return `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photo_reference=${photoReference}&key=${GOOGLE_PLACES_API_KEY}`;
};

const createGoogleMapsUrl = (latitude, longitude, placeName) => {
  if (!latitude || !longitude) return null;
  return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}&query_place=${encodeURIComponent(placeName)}`;
};

const downloadImageFromLine = async (messageId) => {
  const filePath = path.join(__dirname, `./temp/${messageId}.jpg`);
  try {
    const response = await axios.get(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
      headers: { Authorization: `Bearer ${LINE_ACCESS_TOKEN}` },
      responseType: "arraybuffer",
    });
    await promisify(fs.writeFile)(filePath, response.data);
    return filePath;
  } catch (error) {
    console.error("❌ Error downloading image from LINE:", error.response?.data?.error_message || error.message);
    return null;
  }
};

const analyzeImage = async (imagePath) => {
  try {
    const imageBase64 = fs.readFileSync(imagePath, { encoding: "base64" });
    const response = await axios.post(
      `https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_VISION_API_KEY}`,
      {
        requests: [
          {
            image: { content: imageBase64 },
            features: [
              { type: "LABEL_DETECTION", maxResults: 5 },
              { type: "LANDMARK_DETECTION", maxResults: 1 },
            ],
          },
        ],
      }
    );

    const labels = response.data.responses[0].labelAnnotations?.map(label => label.description) || [];
    const landmarks = response.data.responses[0].landmarkAnnotations || [];

    if (landmarks.length > 0) {
      const landmark = landmarks[0];
      return {
        landmark: landmark.description,
        confidence: (landmark.score * 100).toFixed(2),
        labels: labels.length > 0 ? labels : null,
      };
    }

    return {
      landmark: null,
      confidence: null,
      labels: labels.length > 0 ? labels : null,
    };
  } catch (error) {
    console.error("🔥 Image analysis error:", error.response?.data?.error_message || error.message);
    return null;
  }
};

const startLoadingAnimation = async (userId, seconds = 5) => {
  if (seconds < 5 || seconds > 60 || seconds % 5 !== 0) {
    console.warn(`⚠️ loadingSeconds (${seconds}) ไม่ถูกต้อง ปรับเป็น 5 วินาที`);
    seconds = 5;
  }
  const url = "https://api.line.me/v2/bot/chat/loading/start";
  const payload = { chatId: userId, loadingSeconds: seconds };
  try {
    const response = await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${LINE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    });
    console.log(`✅ เริ่มแอนิเมชันโหลด ${seconds} วินาทีสำเร็จ:`, response.status);
    return true;
  } catch (error) {
    console.error("❌ Error starting loading animation:", error.response?.data?.error_message || error.message);
    return false;
  }
};

const sendToLine = async (replyToken, message) => {
  try {
    const messages = Array.isArray(message) ? message : [message];
    for (const msg of messages) {
      if (!msg.type) throw new Error("Invalid message structure: Missing type");
      if (msg.type === "text" && (!msg.text || typeof msg.text !== "string")) {
        throw new Error("Invalid text message: Text is missing or not a string");
      }
      if (msg.quickReply && (!msg.quickReply.items || !Array.isArray(msg.quickReply.items))) {
        throw new Error("Invalid Quick Reply structure: Missing or invalid items");
      }
    }

    console.log("📤 Sending messages to LINE:", JSON.stringify(messages, null, 2));
    await axios.post(
      "https://api.line.me/v2/bot/message/reply",
      { replyToken, messages },
      { headers: { Authorization: `Bearer ${LINE_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log("✅ Sent message to LINE successfully");
  } catch (error) {
    console.error("❌ LINE API error:", error.response?.data || error.message);
    throw new Error("Failed to send message to LINE: " + (error.response?.data?.message || error.message));
  }
};

const pushToLine = async (userId, message) => {
  try {
    const messages = Array.isArray(message) ? message : [message];
    for (const msg of messages) {
      if (!msg.type) throw new Error("Invalid message structure: Missing type");
      if (msg.type === "text" && (!msg.text || typeof msg.text !== "string")) {
        throw new Error("Invalid text message: Text is missing or not a string");
      }
    }

    await axios.post(
      "https://api.line.me/v2/bot/message/push",
      {
        to: userId,
        messages: messages,
      },
      { headers: { Authorization: `Bearer ${LINE_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log(`✅ Pushed message to LINE successfully for user: ${userId}`);
  } catch (error) {
    console.error("❌ LINE Push API error:", error.response?.data?.error_message || error.message);
    throw new Error("Failed to push message to LINE: " + (error.response?.data?.message || error.message));
  }
};

const createPlaceFlexMessage = (placeData) => {
  const photoUrl = getPhotoUrl(placeData.photoReference);
  const contents = [
    { type: "text", text: placeData.name, weight: "bold", size: "xl" },
    { type: "text", text: `ที่อยู่: ${placeData.address}` },
    { type: "text", text: `เรตติ้ง: ${placeData.rating || "N/A"} (รีวิว: ${placeData.userRatingsTotal || "N/A"})` },
    { type: "text", text: `ชั่วโมงเปิด/ปิด: ${placeData.openingHours || "ไม่มีข้อมูล"}`, size: "xs", wrap: true },
  ];

  const mapUrl = createGoogleMapsUrl(placeData.latitude, placeData.longitude, placeData.name);
  if (mapUrl) {
    contents.push({
      type: "button",
      action: {
        type: "uri",
        label: "ดูในแผนที่",
        uri: mapUrl,
      },
      style: "primary",
      color: "#1DB446",
    });
  }

  return {
    type: "flex",
    altText: `ข้อมูลสถานที่: ${placeData.name}`,
    contents: {
      type: "bubble",
      hero: {
        type: "image",
        url: photoUrl,
        size: "full",
        aspectRatio: "20:13",
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: contents,
      },
    },
  };
};

const createRecommendationCarousel = async (places) => {
  const uniquePlaces = [...new Set(places)];
  const locationDataPromises = uniquePlaces.map(place => getLocationFromGooglePlaces(place));
  const locationData = (await Promise.all(locationDataPromises)).filter(data => data);

  if (locationData.length === 0) {
    console.warn("⚠️ No valid places found for carousel");
    return { type: "text", text: "ขออภัย ไม่พบสถานที่ท่องเที่ยวที่แนะนำในขณะนี้" };
  }

  const bubbles = locationData.map(place => {
    const photoUrl = getPhotoUrl(place.photoReference);
    const mapUrl = createGoogleMapsUrl(place.latitude, place.longitude, place.name);

    return {
      type: "bubble",
      hero: {
        type: "image",
        url: photoUrl,
        size: "full",
        aspectRatio: "20:13",
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: place.name, weight: "bold", size: "lg" },
          { type: "text", text: "สถานที่ท่องเที่ยวยอดนิยม", size: "sm" },
          { type: "text", text: `ที่อยู่: ${place.address}`, size: "sm", wrap: true },
          { type: "text", text: `เรตติ้ง: ${place.rating || "N/A"}`, size: "xs" },
        ],
      },
      ...(mapUrl ? {
        footer: {
          type: "box",
          layout: "vertical",
          contents: [
            {
              type: "button",
              action: {
                type: "uri",
                label: "ดูในแผนที่",
                uri: mapUrl,
              },
              style: "primary",
              color: "#1DB446",
            },
          ],
        },
      } : {}),
    };
  });

  return {
    type: "flex",
    altText: "แนะนำที่เที่ยว",
    contents: {
      type: "carousel",
      contents: bubbles,
    },
  };
};

const createHotelRecommendationCarousel = async (hotels) => {
  if (!hotels || hotels.length === 0) {
    console.warn("⚠️ No hotels found for carousel");
    return { type: "text", text: "ขออภัย ไม่พบโรงแรมที่แนะนำในขณะนี้" };
  }

  const bubbles = hotels.map(hotel => {
    const photoUrl = getPhotoUrl(hotel.photoReference);
    const mapUrl = (hotel.latitude && hotel.longitude) ? createGoogleMapsUrl(hotel.latitude, hotel.longitude, hotel.name) : null;

    return {
      type: "bubble",
      hero: {
        type: "image",
        url: photoUrl,
        size: "full",
        aspectRatio: "20:13",
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: hotel.name, weight: "bold", size: "lg" },
          { type: "text", text: "โรงแรมแนะนำ", size: "sm" },
          { type: "text", text: `ที่อยู่: ${hotel.address}`, size: "sm", wrap: true },
          { type: "text", text: `เรตติ้ง: ${hotel.rating || "N/A"}`, size: "xs" },
        ],
      },
      ...(mapUrl ? {
        footer: {
          type: "box",
          layout: "vertical",
          contents: [
            {
              type: "button",
              action: {
                type: "uri",
                label: "ดูในแผนที่",
                uri: mapUrl,
              },
              style: "primary",
              color: "#1DB446",
            },
          ],
        },
      } : {}),
    };
  });

  return {
    type: "flex",
    altText: "แนะนำโรงแรม",
    contents: {
      type: "carousel",
      contents: bubbles,
    },
  };
};

const createQuickReply = (lang = "th") => {
  return {
    items: [
      {
        type: "action",
        action: {
          type: "message",
          label: lang === "th" ? "แนะนำที่เที่ยว" : "Recommend Places",
          text: "แนะนำที่เที่ยว",
        },
      },
      {
        type: "action",
        action: {
          type: "message",
          label: lang === "th" ? "แนะนำโรงแรม" : "Recommend Hotels",
          text: "แนะนำโรงแรม",
        },
      },
      {
        type: "action",
        action: {
          type: "uri",
          label: lang === "th" ? "สร้างแผนการเดินทาง" : "Create Travel Plan",
          uri: "https://tripster-plans.netlify.app/"
        }
      },
    ],
  };
};

const getAIResponseWithMedia = async (userId, userMessage, replyToken) => {
  const loadingStarted = await startLoadingAnimation(userId, 5);
  if (!loadingStarted) console.log("⚠️ Loading Animation failed");

  const userDocRef = doc(db, "chatHistory", userId);
  const userDoc = await getDoc(userDocRef);
  const previousMessages = userDoc.exists() ? userDoc.data().messages || [] : [];

  let detectedLang = "th";
  if (typeof userMessage === "string") {
    const { lang } = await translateText(userMessage);
    detectedLang = lang;
  }

  if (typeof userMessage === "object" && userMessage.type === "sticker") {
    const greetingText = "สวัสดีครับผม Tripster ดีใจที่คุณทักทายมา ลองเลือกคำสั่งด้านล่างเพื่อเริ่มต้นเลยครับ!";
    const greeting = await translateText(greetingText, detectedLang);
    console.log(`📤 Preparing sticker response: ${greeting.text}`);
    return [{
      type: "text",
      text: greeting.text || greetingText,
      quickReply: createQuickReply(detectedLang),
    }];
  }

  const preferences = [];
  if (typeof userMessage === "string") {
    if (userMessage.includes("ธรรมชาติ")) preferences.push("natural_feature");
    if (userMessage.includes("วัฒนธรรม")) preferences.push("museum|church|historical");
    if (userMessage.includes("ผจญภัย")) preferences.push("park|amusement_park");
  }

  if (typeof userMessage === "string" && (userMessage.startsWith("แนะนำที่เที่ยว") || userMessage.startsWith("แนะนำสถานที่") || userMessage.startsWith("ขอที่เที่ยว"))) {
    const destination = userMessage.replace(/แนะนำที่เที่ยว|แนะนำสถานที่|ขอที่เที่ยว/, "").trim() || "ภาคเหนือ";
    const northernProvinces = ["เชียงใหม่", "เชียงราย", "ลำปาง", "ลำพูน", "แม่ฮ่องสอน", "น่าน", "พะเยา", "แพร่", "อุตรดิตถ์"];
    const isNorthern = northernProvinces.some(province => destination.toLowerCase().includes(province.toLowerCase())) || destination.toLowerCase().includes("ภาคเหนือ");
    if (!isNorthern) {
      const errorMsg = await translateText("ขออภัยครับ ผมให้ข้อมูลเฉพาะสถานที่ในภาคเหนือเท่านั้น ลองระบุสถานที่ในภาคเหนือ เช่น เชียงใหม่ หรือ เชียงราย", detectedLang);
      return [{
        type: "text",
        text: errorMsg.text,
        quickReply: createQuickReply(detectedLang),
      }];
    }

    let prompt = `แนะนำสถานที่ท่องเที่ยวยอดนิยม 5 แห่งใน ${destination} ภาคเหนือของประเทศไทย`;
    if (preferences.length > 0) prompt += ` ที่เหมาะกับ ${preferences.join(", ")}`;

    const initialResponse = await getAIResponse(userId, prompt);
    console.log(`🤖 AI recommended places for ${destination}: ${initialResponse}`);
    const places = initialResponse.split("\n")
      .filter(line => line.trim().match(/\d+\.\s*.+/))
      .map(line => line.replace(/^\d+\.\s*/, "").replace(/\*\*/g, "").split(":")[0].trim());
    const locationData = await Promise.all(places.map(place => getLocationFromGooglePlaces(place)));
    const validPlaces = locationData.filter(data => data).map(data => data.name);

    const searchResultsPromises = validPlaces.map(place => searchPlaceWithCustomSearch(place, "สถานที่ท่องเที่ยว"));
    const searchResults = await Promise.all(searchResultsPromises);

    const hotels = await getHotelsNearPlace(destination);
    const placeCarousel = await createRecommendationCarousel(validPlaces.slice(0, 5));
    const hotelCarousel = await createHotelRecommendationCarousel(hotels.slice(0, 5));

    const followUpQuestions = await translateText(
      `ข้อมูลนี้มาจาก Google Places API (ข้อมูล ณ วันที่ ${new Date().toLocaleDateString("th-TH", { year: "numeric", month: "long", day: "numeric" })})\n` +
      "ขอบคุณที่สนใจ! ช่วยบอกเพิ่มเติมหน่อยครับ:\n- งบประมาณต่อวัน (เช่น ต่ำกว่า 2000 บาท)\n- ความชอบ (เช่น ธรรมชาติ, วัฒนธรรม)\n- เดินทางกับใคร (เช่น ครอบครัว, เพื่อน)\n- วิธีการเดินทาง (เช่น รถยนต์, รถไฟ)\nกรุณาพิมพ์คำตอบตามลำดับด้วยคั่นด้วยเครื่องหมาย | หรือเลือกคำสั่งด้านล่างเพื่อดูข้อมูลเพิ่มเติม",
      detectedLang
    );

    const messages = [];
    messages.push(placeCarousel.type === "flex" ? placeCarousel : { type: "text", text: "ขออภัย ไม่พบสถานที่ท่องเที่ยวที่แนะนำในขณะนี้" });

    if (searchResults.length > 0) {
      const searchLinks = searchResults.flat().slice(0, 3).map(result => `- ${result.title}: ${result.link}`).join("\n");
      const searchMessage = await translateText(
        `ข้อมูลเพิ่มเติมเกี่ยวกับสถานที่:\n${searchLinks}`,
        detectedLang
      );
      messages.push({ type: "text", text: searchMessage.text });
    }

    messages.push(hotelCarousel.type === "flex" ? hotelCarousel : { type: "text", text: "ขออภัย ไม่พบโรงแรมที่แนะนำในขณะนี้" });
    messages.push({
      type: "text",
      text: followUpQuestions.text,
      quickReply: createQuickReply(detectedLang),
    });

    return messages;
  }

  if (typeof userMessage === "string" && userMessage.startsWith("ข้อมูล ")) {
    const placeName = userMessage.replace("ข้อมูล ", "").trim();
    const locationData = await getLocationFromGooglePlaces(placeName);
    if (locationData) {
      const details = await getPlaceDetails(locationData.placeId);
      const flexMessage = createPlaceFlexMessage({ ...locationData, ...details });

      const searchResults = await searchPlaceWithCustomSearch(placeName, "สถานที่ท่องเที่ยว");

      const messages = [flexMessage];

      if (searchResults.length > 0) {
        const searchLinks = searchResults.slice(0, 3).map(result => `- ${result.title}: ${result.link}`).join("\n");
        const searchMessage = await translateText(
          `ข้อมูลเพิ่มเติมเกี่ยวกับ ${placeName}:\n${searchLinks}`,
          detectedLang
        );
        messages.push({ type: "text", text: searchMessage.text });
      }

      const followUp = await translateText(
        `ข้อมูลนี้มาจาก Google Places API (ข้อมูล ณ วันที่ ${new Date().toLocaleDateString("th-TH", { year: "numeric", month: "long", day: "numeric" })})\n` +
        "ต้องการดูข้อมูลเพิ่มเติมหรือไม่? ลองเลือกคำสั่งด้านล่างเลยครับ!",
        detectedLang
      );
      messages.push({
        type: "text",
        text: followUp.text,
        quickReply: createQuickReply(detectedLang),
      });

      return messages;
    }
    const errorMsg = await translateText(`ไม่พบข้อมูลของ "${placeName}"`, detectedLang);
    return [{
      type: "text",
      text: errorMsg.text,
      quickReply: createQuickReply(detectedLang),
    }];
  }

  // ✅ ปรับส่วน "แนะนำโรงแรม" ให้ใช้ context "โรงแรม"
  if (typeof userMessage === "string" && (userMessage.startsWith("แนะนำโรงแรม") || userMessage.includes("ขอที่พัก"))) {
    const placeName = userMessage.replace(/แนะนำโรงแรม|ขอที่พัก/, "").trim() || "ภาคเหนือ";
    const northernProvinces = ["เชียงใหม่", "เชียงราย", "ลำปาง", "ลำพูน", "แม่ฮ่องสอน", "น่าน", "พะเยา", "แพร่", "อุตรดิตถ์"];
    const isNorthern = northernProvinces.some(province => placeName.toLowerCase().includes(province.toLowerCase())) || placeName.toLowerCase().includes("ภาคเหนือ");
    if (!isNorthern) {
      const errorMsg = await translateText("ขออภัยครับ ผมให้ข้อมูลเฉพาะสถานที่ในภาคเหนือเท่านั้น ลองระบุสถานที่ในภาคเหนือ เช่น เชียงใหม่ หรือ เชียงราย", detectedLang);
      return [{
        type: "text",
        text: errorMsg.text,
        quickReply: createQuickReply(detectedLang),
      }];
    }

    const hotels = await getHotelsNearPlace(placeName);
    const carousel = await createHotelRecommendationCarousel(hotels);

    const searchResultsPromises = hotels.map(hotel => searchPlaceWithCustomSearch(hotel.name, "โรงแรม"));
    const searchResults = await Promise.all(searchResultsPromises);

    const messages = [
      carousel.type === "flex" ? carousel : { type: "text", text: "ขออภัย ไม่พบโรงแรมที่แนะนำในขณะนี้" },
    ];

    if (searchResults.length > 0) {
      const searchLinks = searchResults.flat().slice(0, 3).map(result => `- ${result.title}: ${result.link}`).join("\n");
      const searchMessage = await translateText(
        `ข้อมูลเพิ่มเติมเกี่ยวกับโรงแรม:\n${searchLinks}`,
        detectedLang
      );
      messages.push({ type: "text", text: searchMessage.text });
    }

    const followUp = await translateText(
      `ข้อมูลนี้มาจาก Google Places API (ข้อมูล ณ วันที่ ${new Date().toLocaleDateString("th-TH", { year: "numeric", month: "long", day: "numeric" })})\n` +
      "ต้องการดูข้อมูลเพิ่มเติมหรือไม่? ลองเลือกคำสั่งด้านล่างเลยครับ!",
      detectedLang
    );
    messages.push({
      type: "text",
      text: followUp.text,
      quickReply: createQuickReply(detectedLang),
    });

    return messages;
  }

  if (typeof userMessage === "string" && (userMessage.startsWith("สภาพอากาศ ") || userMessage.startsWith("สภาพอากาศปัจจุบัน"))) {
    const placeName = userMessage.replace(/สภาพอากาศ(ปัจจุบัน)?/, "").trim() || "กรุงเทพมหานคร";
    const locationData = await getLocationFromGooglePlaces(placeName);
    if (locationData) {
      const flexMessage = createPlaceFlexMessage(locationData);
      const followUp = await translateText("ต้องการดูข้อมูลเพิ่มเติมหรือไม่? ลองเลือกคำสั่งด้านล่างเลยครับ!", detectedLang);
      return [
        flexMessage,
        {
          type: "text",
          text: followUp.text,
          quickReply: createQuickReply(detectedLang),
        },
      ];
    }
    const errorMsg = await translateText(`ไม่พบข้อมูลสภาพอากาศของ "${placeName}"`, detectedLang);
    return [{
      type: "text",
      text: errorMsg.text,
      quickReply: createQuickReply(detectedLang),
    }];
  }

  if (typeof userMessage === "string" && userMessage.startsWith("แผนที่")) {
    const placeName = userMessage.replace("แผนที่", "").trim();
    const locationData = await getLocationFromGooglePlaces(placeName);
    console.log(`📍 Location data for ${placeName}:`, locationData);
    if (locationData && locationData.latitude && locationData.longitude) {
      const locationMessage = {
        type: "location",
        title: `${placeName}`,
        address: locationData.address,
        latitude: locationData.latitude,
        longitude: locationData.longitude,
      };
      const followUp = await translateText("ต้องการดูข้อมูลเพิ่มเติมหรือไม่? ลองเลือกคำสั่งด้านล่างเลยครับ!", detectedLang);
      return [
        locationMessage,
        {
          type: "text",
          text: followUp.text,
          quickReply: createQuickReply(detectedLang),
        },
      ];
    }
    const errorMsg = await translateText(`ไม่พบข้อมูลแผนที่ของ "${placeName}" กรุณาตรวจสอบชื่อสถานที่`, detectedLang);
    return [{
      type: "text",
      text: errorMsg.text,
      quickReply: createQuickReply(detectedLang),
    }];
  }

  if (typeof userMessage === "string" && userMessage === "ติดต่อหน่วยงานที่เกี่ยวข้อง") {
    const imageMap1 = {
      type: "imagemap",
      baseUrl: "https://tripster-plans.netlify.app/images/contact_imagemap1.png?w=auto",
      altText: "ติดต่อหน่วยงานที่เกี่ยวข้อง (กลุ่ม 1)",
      baseSize: {
        width: 1040,
        height: 1040
      },
      actions: [
        { type: "uri", linkUri: "tel:1669", area: { x: 0, y: 300, width: 1040, height: 350 } },
        { type: "uri", linkUri: "tel:191", area: { x: 0, y: 540, width: 1040, height: 340 } },
        { type: "uri", linkUri: "tel:1155", area: { x: 0, y: 778, width: 1040, height: 346 } }
      ]
    };

    const imageMap2 = {
      type: "imagemap",
      baseUrl: "https://tripster-plans.netlify.app/images/contact_imagemap2.png?w=auto",
      altText: "ติดต่อหน่วยงานที่เกี่ยวข้อง (กลุ่ม 2)",
      baseSize: {
        width: 1040,
        height: 1040
      },
      actions: [
        { type: "uri", linkUri: "tel:1196", area: { x: 0, y: 300, width: 1040, height: 347 } },
        { type: "uri", linkUri: "tel:1860", area: { x: 0, y: 540, width: 1040, height: 347 } },
        { type: "uri", linkUri: "tel:+6622831500", area: { x: 0, y: 778, width: 1040, height: 346 } }
      ]
    };

    const followUp = await translateText("ต้องการดูข้อมูลเพิ่มเติมหรือไม่? ลองเลือกคำสั่งด้านล่างเลยครับ!", detectedLang);
    return [
      imageMap1,
      imageMap2,
      {
        type: "text",
        text: followUp.text,
        quickReply: createQuickReply(detectedLang),
      },
    ];
  }

  const aiResponse = await getAIResponse(userId, typeof userMessage === "string" ? userMessage : "ผู้ใช้ส่งสติกเกอร์");
  const isPlaceList = aiResponse.match(/\d+\.\s*.+/g);
  if (isPlaceList) {
    const places = aiResponse.split("\n")
      .filter(line => line.trim().match(/\d+\.\s*.+/))
      .map(line => line.replace(/^\d+\.\s*/, "").replace(/\*\*/g, "").split(":")[0].trim());
    const locationData = await Promise.all(places.map(place => getLocationFromGooglePlaces(place)));
    const validPlaces = locationData.filter(data => data).map(data => data.name);

    const searchResultsPromises = validPlaces.map(place => searchPlaceWithCustomSearch(place, "สถานที่ท่องเที่ยว"));
    const searchResults = await Promise.all(searchResultsPromises);

    const carousel = await createRecommendationCarousel(validPlaces);
    const messages = [
      carousel.type === "flex" ? carousel : { type: "text", text: "ขออภัย ไม่พบสถานที่ท่องเที่ยวที่แนะนำในขณะนี้" },
    ];

    if (searchResults.length > 0) {
      const searchLinks = searchResults.flat().slice(0, 3).map(result => `- ${result.title}: ${result.link}`).join("\n");
      const searchMessage = await translateText(
        `ข้อมูลเพิ่มเติมเกี่ยวกับสถานที่:\n${searchLinks}`,
        detectedLang
      );
      messages.push({ type: "text", text: searchMessage.text });
    }

    const followUp = await translateText(
      `ข้อมูลนี้มาจาก Google Places API (ข้อมูล ณ วันที่ ${new Date().toLocaleDateString("th-TH", { year: "numeric", month: "long", day: "numeric" })})\n` +
      "ต้องการดูข้อมูลเพิ่มเติมหรือไม่? ลองเลือกคำสั่งด้านล่างเลยครับ!",
      detectedLang
    );
    messages.push({
      type: "text",
      text: followUp.text,
      quickReply: createQuickReply(detectedLang),
    });

    return messages;
  }

  if (aiResponse.includes("แสดงรูปภาพ")) {
    const imageMessage = {
      type: "image",
      originalContentUrl: "https://example.com/travel_image.jpg",
      previewImageUrl: "https://example.com/travel_image.jpg",
    };
    const followUp = await translateText("ต้องการดูข้อมูลเพิ่มเติมหรือไม่? ลองเลือกคำสั่งด้านล่างเลยครับ!", detectedLang);
    return [
      imageMessage,
      {
        type: "text",
        text: followUp.text,
        quickReply: createQuickReply(detectedLang),
      },
    ];
  }

  const translatedResponse = await translateText(aiResponse, detectedLang);
  const quickReplyMessage = {
    type: "text",
    text: translatedResponse.text,
    quickReply: createQuickReply(detectedLang),
  };
  return [quickReplyMessage];
};

app.post("/submit-travel-plan", async (req, res) => {
  const { userId, startLocation, destination, budget, preference, travelWith, transport, travelDateStart, travelDateEnd } = req.body;

  if (!userId || !startLocation || !destination || !budget || !preference || !travelWith || !transport || !travelDateStart || !travelDateEnd) {
    console.error("❌ Missing required fields in request body", req.body);
    return res.status(400).send("Missing required fields");
  }

  try {
    const aiPrompt = `
      ช่วยวางแผนการท่องเที่ยวในประเทศไทยโดยอิงจากข้อมูลต่อไปนี้:
      - จุดเริ่มต้น: ${startLocation}
      - ปลายทาง: ${destination}
      - งบประมาณ: ${budget} บาท
      - ความชอบ: ${preference}
      - เดินทางกับ: ${travelWith}
      - วิธีการเดินทาง: ${transport}
      - วันเดินทางไป: ${travelDateStart}
      - วันเดินทางกลับ: ${travelDateEnd}
      แนะนำสถานที่ท่องเที่ยว 2-3 แห่งที่เหมาะสมกับความชอบและงบประมาณ พร้อมชื่อสถานที่, ที่อยู่, และคำอธิบายสั้น ๆ
      แนะนำโรงแรม 1-2 แห่งใกล้สถานที่ท่องเที่ยวหลัก โดยพิจารณาความนิยม (เรตติ้ง) และราคาที่เหมาะสมกับ ${budget} บาท
      หากเดินทางจาก ${startLocation} ไป ${destination} ด้วย ${transport} ควรใช้เส้นทางไหน หรือมีคำแนะนำอะไรเพิ่มเติม
      หากไม่มีข้อมูลตรงตามความชอบ ให้แนะนำสถานที่ยอดนิยมใกล้เคียงใน ${destination}
    `;

    console.log(`📝 Sending prompt to AI for user ${userId}: ${aiPrompt}`);

    const aiResponse = await getAIResponse(userId, aiPrompt);
    console.log(`🤖 AI Response: ${aiResponse}`);

    const locations = aiResponse.split("\n").filter(line => line.trim());
    const placeNames = locations
      .filter(line => line.match(/สถานที่ท่องเที่ยว/) || line.match(/ที่เที่ยว/))
      .map(line => line.replace(/สถานที่ท่องเที่ยว: |ที่เที่ยว: /, "").split(" - ")[0].trim());
    const hotelNames = locations
      .filter(line => line.match(/โรงแรม/))
      .map(line => line.replace(/โรงแรม: /, "").split(" - ")[0].trim());

    const placeCarousel = await createRecommendationCarousel(placeNames.slice(0, 3));
    const hotelCarousel = await createHotelRecommendationCarousel(
      (await getHotelsNearPlace(destination)).slice(0, 2)
    );

    const messages = [];
    messages.push({ type: "text", text: `🗺️ แผนการท่องเที่ยวจาก ${startLocation} ถึง ${destination}:\n${aiResponse}` });
    if (placeCarousel.type === "flex") messages.push(placeCarousel);
    if (hotelCarousel.type === "flex") messages.push(hotelCarousel);
    messages.push({
      type: "text",
      text: "ต้องการดูข้อมูลเพิ่มเติมหรือไม่? ลองเลือกคำสั่งด้านล่างเลยครับ!",
      quickReply: createQuickReply("th"),
    });

    await pushToLine(userId, messages);
    console.log(`✅ Successfully sent travel plan to LINE for user: ${userId}`);

    res.status(200).send("Processed successfully");
  } catch (error) {
    console.error("❌ Error processing travel plan:", error.message);
    res.status(500).send("Error processing data");
  }
});

app.post("/webhook", async (req, res) => {
  const events = req.body.events;
  if (!events || !Array.isArray(events)) {
    console.error("❌ Invalid webhook event data");
    return res.status(400).json({ error: "Invalid event data" });
  }

  for (const event of events) {
    const replyToken = event.replyToken;
    const userId = event.source.userId;

    if (event.type === "message") {
      try {
        if (event.message.type === "text") {
          const userMessage = event.message.text;
          console.log(`📩 Received text message from user ${userId}: ${userMessage}`);

          const userDocRef = doc(db, "chatHistory", userId);
          const userDoc = await getDoc(userDocRef);
          const isFirstMessage = !userDoc.exists();

          const messages = await getAIResponseWithMedia(userId, userMessage, replyToken);

          if (isFirstMessage && messages.length > 0) {
            const lastMessage = messages[messages.length - 1];
            if (!lastMessage.quickReply) {
              const { lang: detectedLang } = await translateText(userMessage);
              const welcomeMessage = await translateText("ยินดีต้อนรับสู่ Tripster! ลองเลือกคำสั่งด้านล่างเพื่อเริ่มต้นเลยครับ!", detectedLang);
              messages.push({
                type: "text",
                text: welcomeMessage.text,
                quickReply: createQuickReply(detectedLang),
              });
            }
          }

          if (messages && messages.length > 0) {
            await sendToLine(replyToken, messages);
          }
        } else if (event.message.type === "image") {
          console.log(`📸 Received image message from user ${userId}`);
          const loadingStarted = await startLoadingAnimation(userId, 10);
          if (!loadingStarted) console.log("⚠️ Loading Animation failed for image");

          const imagePath = await downloadImageFromLine(event.message.id);
          if (imagePath) {
            const analysisResult = await analyzeImage(imagePath);
            const { lang } = await translateText("ภาพนี้");
            let message;
            if (analysisResult) {
              if (analysisResult.landmark) {
                message = await translateText(
                  `ภาพนี้น่าจะเป็น "${analysisResult.landmark}" (ความมั่นใจ ${analysisResult.confidence}%)` +
                    (analysisResult.labels ? `\nรายละเอียดเพิ่มเติม: ${analysisResult.labels.join(", ")}` : ""),
                  lang
                );
              } else {
                message = await translateText(
                  analysisResult.labels
                    ? `ไม่สามารถระบุสถานที่ได้ แต่ภาพนี้อาจเกี่ยวข้องกับ: ${analysisResult.labels.join(", ")}`
                    : "ไม่สามารถวิเคราะห์ภาพได้",
                  lang
                );
              }
            } else {
              message = await translateText("ไม่สามารถวิเคราะห์ภาพได้", lang);
            }
            await sendToLine(replyToken, [{
              type: "text",
              text: message.text,
              quickReply: createQuickReply(lang),
            }]);
            fs.unlink(imagePath, (err) => {
              if (err) console.error(`❌ Error deleting file ${imagePath}:`, err.message);
            });
          } else {
            const errorMsg = await translateText("ไม่สามารถดาวน์โหลดภาพได้", "th");
            await sendToLine(replyToken, [{
              type: "text",
              text: errorMsg.text,
              quickReply: createQuickReply("th"),
            }]);
          }
        } else if (event.message.type === "sticker") {
          console.log(`🎉 Received sticker message from user ${userId}`);
          const messages = await getAIResponseWithMedia(userId, event.message, replyToken);
          await sendToLine(replyToken, messages);
        }
      } catch (error) {
        console.error("❌ Webhook processing error:", error.message);
        const errorMsg = await translateText("เกิดข้อผิดพลาดในการประมวลผล กรุณาลองใหม่", "th");
        try {
          await sendToLine(replyToken, [{
            type: "text",
            text: errorMsg.text,
            quickReply: createQuickReply("th"),
          }]);
        } catch (sendError) {
          console.error("❌ Failed to send error message to LINE:", sendError.message);
        }
      }
    }
  }
  res.status(200).send("Webhook received!");
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Tripster พร้อมให้ข้อมูลการท่องเที่ยวที่พอร์ต ${PORT}`));