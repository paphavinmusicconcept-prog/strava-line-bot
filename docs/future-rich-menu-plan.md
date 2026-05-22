# Future Rich Menu Plan

เอกสารนี้เป็นแผน rich menu ในอนาคตสำหรับลดความซ้ำซ้อนของเมนู และทำให้ผู้ใช้เข้าถึงเมนูหลักได้กระชับขึ้น

## เป้าหมาย

- ลดจำนวนปุ่มที่ซ้ำหน้าที่กันใน rich menu
- แยกเมนูใช้งานประจำออกจากเมนูตั้งค่า
- ให้ `HR Zone` อยู่ใน `Profile Setting` เพราะเป็นข้อมูลโปรไฟล์ที่ระบบนำไปใช้ต่อ
- ใช้ rich menu เป็นทางลัดเข้า flow หลัก ไม่ใช้เป็นพื้นที่ใส่รายละเอียดทั้งหมด

## Rich Menu Structure

```text
Rich Menu v1
┌──────────────────────────────┐
│ Today Coach                  │
├──────────┬──────────┬────────┤
│ Stat     │ Training │ Profile│
│          │ Plan     │ Setting│
└──────────┴──────────┴────────┘
```

หลักการเรียงตามความสำคัญและความถี่ในการกด:

1. `Today Coach` อยู่ช่องใหญ่ที่สุดด้านบน เพราะเป็นปุ่มหลักที่ผู้ใช้ควรกดบ่อยสุด
2. `Stat` อยู่ช่องล่าง สำหรับดูย้อนหลังว่าเมื่อก่อนเป็นยังไง
3. `Training Plan` อยู่ช่องล่าง สำหรับดูว่าต่อไปต้องซ้อมอะไรและจัดการเป้าหมาย
4. `Profile Setting` อยู่ช่องล่าง สำหรับตั้งค่า HR Zone และข้อมูลส่วนตัว

`Weight Training` ไม่อยู่เป็นช่องหลักใน v1 นี้ แต่ให้เข้าได้จาก `Today Coach` หรือ `Training Plan` เมื่อคำแนะนำบอกว่าควรเล่นเวท

## Template Size And Bounds

ใช้ template แบบใหญ่:

```text
Image size: 2500 x 1686 px
Layout: 1 big top area + 3 bottom areas
```

ตำแหน่งกดที่ควรใช้:

```text
Today Coach
x: 0
y: 0
width: 2500
height: 843
action: action=today_coach

Stat
x: 0
y: 843
width: 833
height: 843
action: action=stat

Training Plan
x: 833
y: 843
width: 834
height: 843
action: action=training_plan

Profile Setting
x: 1667
y: 843
width: 833
height: 843
action: action=profile_setting
```

## 0. Today Coach

ใช้เป็นปุ่มหลักของแอปสำหรับตอบคำถามว่า "วันนี้ควรทำอะไร"

ตัวเลือกหลังจากกด `Today Coach`:

```text
Today Coach
- วันนี้ควรซ้อมอะไร
- ควรพักไหม
- วิ่งเบาหรือเวทดี
- ปรับแผนให้หน่อย
```

Flow:

```text
User กด Today Coach
→ Bot ส่ง Quick Reply ให้เลือกคำถามหลัก
→ User เลือกคำถาม
→ Bot ดูข้อมูลล่าสุด เช่น running load, recovery, weight training feedback, goal
→ Bot แนะนำวันนี้ว่าควรวิ่ง, พัก, เวท หรือปรับแผน
```

สรุป:

```text
Today Coach = วันนี้ควรทำอะไร
```

## 1. Stat

ใช้สำหรับดูสถิติการซ้อมตามช่วงเวลา

ตัวเลือกหลังจากกด `Stat`:

```text
Stat
- วันนี้
- สัปดาห์นี้
- เดือนนี้
- 3 เดือนนี้
```

Flow:

```text
User กด Stat
→ Bot ส่ง Quick Reply หรือ Flex Message ให้เลือกช่วงเวลา
→ User เลือกช่วงเวลา
→ Bot ดึงสถิติจาก Strava หรือ Database
→ Bot สรุปผล เช่น ระยะทาง, เวลา, pace, heart rate, จำนวนกิจกรรม
```

ตัวอย่างคำตอบ:

```text
สถิติวันนี้ของคุณ

ระยะทางรวม: 8.2 km
เวลา: 48 นาที
Pace เฉลี่ย: 5:51/km
HR เฉลี่ย: 148 bpm
Zone หลัก: Zone 2

วันนี้เป็นงานฐานที่ดี วิ่งอยู่ในโซนสบายเป็นหลัก
```

## 2. Training Plan

ใช้สำหรับดูแผนซ้อมตามช่วงเวลา

ตัวเลือกหลังจากกด `Training Plan`:

```text
Training Plan
- แผนวันนี้
- สัปดาห์นี้
- เดือนนี้
```

Flow:

```text
User กด Training Plan
→ Bot ส่งตัวเลือกช่วงแผน
→ User เลือก วันนี้ / สัปดาห์นี้ / เดือนนี้
→ Bot ดึง training plan ของ user
→ Bot แสดงแผนพร้อมคำแนะนำจาก coach
```

ตัวอย่างคำตอบ:

```text
แผนวันนี้

วิ่ง Easy Run 45 นาที
เป้าหมาย: Zone 2
เน้นคุมหัวใจ ไม่ต้องเร่ง pace

ถ้ารู้สึกล้า ให้ลดเหลือ 30 นาทีได้
```

## 3. Weight Training

เมนูนี้ดีอยู่แล้วและยังไม่ต้องแก้ในรอบนี้

Flow ปัจจุบันที่ควรคงไว้:

```text
User กด Weight Training
→ Bot แสดงเมนูหรือแผนเวท
→ User เลือกโปรแกรม
→ Bot ส่งรายละเอียดท่า จำนวนเซ็ต จำนวนครั้ง และคำแนะนำ
```

หมายเหตุ:

- ไม่ควรนำ `HR Zone` หรือ profile setting มาปนใน flow นี้
- ควรรักษา logic เดิมไว้ก่อน เพื่อลดผลกระทบต่อระบบที่ใช้งานอยู่

## 4. Q&A with coach

ใช้เป็นทางเข้าคุยกับ coach โดยตรง

Flow:

```text
User กด Q&A with coach
→ Bot เปิดโหมดถามตอบ
→ User พิมพ์คำถาม
→ Bot ตอบโดยใช้ข้อมูลโปรไฟล์, training history และ HR Zone ถ้ามี
```

ตัวอย่างคำถาม:

```text
- วันนี้ควรวิ่งไหม
- pace นี้หนักไปไหม
- ทำไม HR สูงกว่าปกติ
- พรุ่งนี้ควรซ้อมอะไร
```

ตัวอย่างคำตอบ:

```text
ภาวิน วันนี้ HR สูงกว่าปกตินิดหน่อย
ถ้าเมื่อคืนพักผ่อนน้อย แนะนำให้ลดเป็น Easy 30 นาทีพอ
```

## 5. Profile Setting

ใช้เป็นศูนย์กลางข้อมูลส่วนตัวและ HR Zone

แนะนำให้ทำเป็น LIFF หรือ mini web เพราะมีหลายช่องกรอก และผู้ใช้อาจต้องกลับมาแก้ข้อมูลภายหลัง

ข้อมูลที่ควรมี:

```text
ชื่อ
อายุ
Resting HR
Max HR
HR Zone 1-5
```

Flow:

```text
User กด Profile Setting
→ เปิด LIFF / Mini Web
→ User กรอกหรือแก้ไขข้อมูล
→ ระบบคำนวณ HR Zone
→ บันทึก profile
→ Bot ใช้ข้อมูลนี้ใน Stat, Training Plan และ Q&A
```

หลังบันทึกแล้ว Bot อาจตอบ:

```text
บันทึกโปรไฟล์แล้ว

HR Zone ของคุณ:
Zone 1: ฟื้นฟู
Zone 2: วิ่งสบาย สร้างฐาน
Zone 3: เทมโปเบา
Zone 4: หนัก ช่วยความเร็ว
Zone 5: หนักมาก ใช้เป็นช่วงสั้น ๆ
```

## HR Zone ใน Profile Setting

หลักการ:

- ให้ user กรอก `อายุ`, `Resting HR`, `Max HR`
- ระบบคำนวณ Zone 1-5 ให้อัตโนมัติ
- ไม่ควรแสดงแค่ตัวเลข HR แต่ควรอธิบายว่าแต่ละโซนใช้ทำอะไร

คำอธิบายโซนแบบคนทั่วไปเข้าใจ:

```text
Zone 1 = ฟื้นฟู
Zone 2 = วิ่งสบาย สร้างฐาน
Zone 3 = เทมโปเบา
Zone 4 = หนัก ช่วยความเร็ว
Zone 5 = หนักมาก ใช้เป็นช่วงสั้น ๆ
```

## Implementation Notes

- รอบแรกของ 4-slot rich menu ให้เริ่มจาก backend action mapping และ Quick Reply ก่อน
- จากนั้นค่อยอัปโหลดรูป rich menu ใหม่เมื่อ asset พร้อม
- Rich Menu action ที่ควรรองรับคือ `today_coach`, `stat`, `training_plan`, `profile_setting`
- จากนั้นค่อยเพิ่ม Quick Reply / Flex Message สำหรับ `Stat`, `Training Plan`, `Today Coach`, และ `Profile Setting`
- `Profile Setting` ควรแยกเป็น LIFF / mini web เพื่อให้ UX กรอกข้อมูลดีขึ้น
