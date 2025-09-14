import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { personas } from "../personas.js"; // note .js and type
const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});
export async function geminiReply(major, history, userMsg) {
    const contents = [
        ...history.map(h => ({ role: h.role, parts: [{ text: h.text }] })),
        { role: "user", parts: [{ text: userMsg }] }
    ];
    const resp = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents,
        config: {
            systemInstruction: personas[major],
            temperature: 0.9,
            topP: 0.95,
            maxOutputTokens: 256
        }
    });
    return resp?.text ?? "";
}
