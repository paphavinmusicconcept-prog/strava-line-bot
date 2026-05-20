function createClaudeService({ anthropic, logger, withRetry }) {
  // ===== CLAUDE HELPERS =====
  async function analyzeWithClaudeWithHistory(prompt, history = []) {
    try {
      const safeHistory = Array.isArray(history)
        ? history.filter(m => m.role && m.content).slice(-12)
        : [];
  
      const messages = [
        ...safeHistory,
        { role: "user", content: prompt },
      ];
  
      const res = await withRetry(() => anthropic.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 1500,
        system: `คุณคืออาจารย์นักวิ่ง AI ผู้ชายที่มีประสบการณ์สูง ผ่านการแข่งมาราธอนและอัลตร้ามาราธอนมาแล้วนับไม่ถ้วน
  
  บุคลิก:
  - เป็นกันเอง สนุก เฮฮา
  - ใช้คำว่า "เฮ้ย", "โอ้โห", "เจ๋งมาก!" บ้างเป็นครั้งคราว
  - เรียกตัวเองว่า "อาจารย์" หรือ "ผม"
  - ตอบภาษาไทยเป็นหลัก
  - motivate ผู้ใช้เสมอ
  - ถ้าขี้เกียจให้แซวเบา ๆ ไม่ดุ
  - ใช้ข้อมูล user context ให้มากที่สุด
  - ถ้าข้อมูลไม่พอ ให้ถามต่อแบบธรรมชาติ`,
        messages,
      }), {
        onRetry: (error, meta) => logger.warn("Retrying Claude request with history", {
          error: error.message,
          ...meta,
        }),
      });
  
      return res.content?.[0]?.text || "ขอโทษครับ อาจารย์ยังตอบไม่ได้ตอนนี้";
    } catch (e) {
      console.error("Claude with history error:", e.message);
      return await analyzeWithClaude(prompt);
    }
  }
  
  async function analyzeWithClaude(prompt, imageBase64 = null) {
    try {
      const messages = [];
  
      if (imageBase64) {
        messages.push({
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: imageBase64,
              },
            },
            { type: "text", text: prompt },
          ],
        });
      } else {
        messages.push({
          role: "user",
          content: prompt,
        });
      }
  
      const res = await withRetry(() => anthropic.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 1500,
        system: `คุณคืออาจารย์นักวิ่ง AI ผู้ชายที่มีประสบการณ์สูง มีความรู้ลึกด้านการวิ่ง โภชนาการ และการฝึกซ้อม
  
  บุคลิก:
  - เป็นกันเอง สนุก เฮฮา
  - ใช้ภาษาไทยเป็นหลัก
  - เรียกตัวเองว่า "อาจารย์" หรือ "ผม"
  - ชอบ motivate และฉลองความสำเร็จเล็ก ๆ
  - ถ้าผู้ใช้ส่งรูปผลการวิ่ง ให้อ่านค่าและคืน JSON บรรทัดแรกเสมอ แต่ห้ามอธิบาย JSON ให้ user เห็น
  
  เมื่อวิเคราะห์รูปผลการวิ่ง ให้ return JSON แบบนี้ในบรรทัดแรก:
  {"distance": 8.5, "pace": 5.5, "duration": 46.75, "calories": 420, "elevGain": 120, "date": "2026-05-16"}
  
  pace เป็นตัวเลขทศนิยม เช่น 5:30/km = 5.5`,
        messages,
      }), {
        onRetry: (error, meta) => logger.warn("Retrying Claude request", {
          error: error.message,
          ...meta,
        }),
      });
  
      return res.content?.[0]?.text || "";
    } catch (e) {
      console.error("Claude error:", e.message);
      return "ขอโทษครับ ตอนนี้ AI วิเคราะห์ไม่ได้ชั่วคราว ลองใหม่อีกครั้งนะครับ";
    }
  }

  return { analyzeWithClaudeWithHistory, analyzeWithClaude };
}

module.exports = { createClaudeService };
