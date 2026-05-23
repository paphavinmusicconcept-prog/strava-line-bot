# Strava Coach LINE Bot

โปรเจกต์นี้คือ LINE Bot สำหรับนักวิ่ง

แอปนี้ช่วยอ่านผลวิ่ง สรุปสถิติ แนะนำการซ้อม และช่วยจัดโปรแกรมเวทให้เข้ากับข้อมูลการวิ่งของผู้ใช้

## ภาพรวมแบบง่าย

ผู้ใช้คุยกับ bot ผ่าน LINE แล้ว bot จะช่วยตอบเรื่องการวิ่ง เช่น วันนี้ควรซ้อมอะไร ดูสถิติย้อนหลัง ตั้งค่า HR Zone หรือให้โปรแกรม Weight Training

ระบบจริงตอนนี้รันอยู่บน Render และใช้ GitHub เป็นที่เก็บไฟล์หลักของโปรเจกต์

## เมนูหลักของแอป

| เมนู | ใช้ทำอะไร |
| --- | --- |
| Today Coach | ถามว่า วันนี้ควรซ้อมอะไร ควรพักไหม หรือควรเวทไหม |
| Stat | ดูข้อมูลย้อนหลัง เช่น วันนี้ สัปดาห์นี้ เดือนนี้ และ 3 เดือนล่าสุด |
| Training Plan | ดูแผนซ้อม เป้าหมาย และสิ่งที่ควรทำต่อ |
| Profile Setting | ตั้งค่า HR Zone และข้อมูลส่วนตัว |
| Weight Training | ให้ bot ถามเป็นขั้นตอน แล้วส่งโปรแกรมเวทให้ |

## Profile Setting LIFF

ปุ่ม `Profile Setting` เปิดหน้า LIFF สำหรับแก้ข้อมูลโปรไฟล์และ HR Zone ในหน้าเดียว

ตั้งค่า LIFF endpoint ใน LINE Developers เป็น:

```text
https://strava-line-bot.onrender.com/liff/profile
```

แล้วใส่ LIFF ID ใน Render:

```text
PROFILE_LIFF_ID=xxxxxxxxxx-xxxxxxxx
```

ถ้ายังไม่ตั้ง `PROFILE_LIFF_ID` bot จะ fallback ไปเปิด URL ตรงของ `/liff/profile` สำหรับทดสอบ

## Rich Menu แบบใหม่

แผน Rich Menu รอบถัดไปจะทำให้เมนูสะอาดขึ้น เหลือ 4 ช่องหลัก

```text
[ Today Coach ]

[ Stat ] [ Training Plan ] [ Profile Setting ]
```

ขนาดรูปที่ใช้คือ `2500 x 1686 px`

| ช่อง | action |
| --- | --- |
| Today Coach | `action=today_coach` |
| Stat | `action=stat` |
| Training Plan | `action=training_plan` |
| Profile Setting | `action=profile_setting` |

รายละเอียดตำแหน่งกดของแต่ละช่องอยู่ใน `docs/future-rich-menu-plan.md`

## Weight Training ทำงานยังไง

Flow ปัจจุบันเป็นแบบถามทีละขั้น

```text
เลือกส่วนที่อยากเล่น
เลือกเวลาที่มี
เลือกอุปกรณ์
bot ส่งโปรแกรมเวท
กดบันทึกว่าทำแล้ว
bot ถามว่าเบาไป กำลังดี หรือหนักไป
bot เก็บ feedback ไว้ปรับครั้งต่อไป
```

ข้อมูลระหว่างทำ flow นี้เก็บใน database แล้ว จึงไม่หายง่ายถ้า Render restart

## ระบบที่ใช้งานจริง

| รายการ | ค่า |
| --- | --- |
| Render service | `strava-line-bot` |
| App URL | `https://strava-line-bot.onrender.com` |
| Health check | `https://strava-line-bot.onrender.com/health` |
| LINE webhook | `https://strava-line-bot.onrender.com/webhook` |

## ไฟล์ที่ควรรู้จัก

| ไฟล์ | ใช้ทำอะไร |
| --- | --- |
| `AGENTS.md` | context และกติกากลางให้ Codex อ่านก่อนทำงาน |
| `README.md` | ภาพรวมโปรเจกต์แบบอ่านง่าย |
| `index.js` | ไฟล์หลักของ bot |
| `docs/future-rich-menu-plan.md` | แผน Rich Menu รุ่นถัดไป |
| `tests/workflow-static.test.js` | test เช็ค workflow สำคัญ |

## คำสั่งที่ใช้บ่อย

```bash
npm install
npm test
node --check index.js
```

## ทำงานต่อจากหลายเครื่อง

ถ้าเปิด repo นี้จากคอมบ้านหรือคอมที่ทำงาน ให้ Codex อ่าน `AGENTS.md` และ `README.md` ก่อนเสมอ

สองไฟล์นี้คือ context กลางของโปรเจกต์ เพื่อให้ทุกเครื่องเข้าใจภาพเดียวกันและทำงานต่อเนื่องได้

## สถานะล่าสุด

ระบบหลักใช้งานได้แล้ว

backend รองรับ Rich Menu 4 ช่องแล้ว

ขั้นต่อไปคือทำรูป Rich Menu ใหม่ แล้วอัปโหลดเข้า LINE ตาม action ที่เตรียมไว้
