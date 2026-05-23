# Profile Setting Workflow

เอกสารนี้เป็นสเปกสำหรับทำ `Profile Setting` ให้เป็น feature จริงของแอป ไม่ใช่แค่ปุ่ม quick reply

เป้าหมายคือให้ผู้ใช้ตั้งค่าข้อมูลร่างกายและ HR Zone ได้ง่าย แล้วให้ข้อมูลนี้ถูกนำไปใช้ต่อใน `Stat`, `Today Coach`, `Training Plan`, rich message ผลวิ่ง และ coaching engine ในอนาคต

## สถานะปัจจุบัน

ตอนนี้ระบบมีสิ่งเหล่านี้แล้ว:

- Rich Menu มีปุ่ม `Profile Setting`
- backend รองรับ action `action=profile_setting`
- bot ส่ง quick reply สำหรับ `ตั้งค่า HR Zone`, `ดูโปรไฟล์`, `แก้ Max HR`, `แก้ Resting HR`
- มี PostgreSQL ใช้เก็บข้อมูลผู้ใช้และ workflow session
- มี `user_memory` สำหรับเก็บ context บางส่วนของผู้ใช้

สิ่งที่ยังต้องทำ:

- ทำ flow ตั้งค่า profile แบบเป็นขั้นตอน
- เก็บข้อมูล profile และ HR Zone ใน database แบบถาวร
- แสดง profile ปัจจุบันเป็น rich message
- ให้ส่วนอื่นของแอปอ่าน HR Zone ไปใช้จริง
- เพิ่ม test สำหรับ flow นี้

## หลักคิดของ Feature

`Profile Setting` ควรตอบคำถามว่า:

```text
ฉันเป็นใคร
หัวใจฉันอยู่โซนไหน
ระบบควรใช้ข้อมูลอะไรเพื่อแนะนำฉันให้แม่นขึ้น
```

ข้อมูลนี้ไม่ควรถูกมองเป็นแค่หน้าตั้งค่า แต่เป็นฐานกลางสำหรับ personalization ของแอป

## เมนูหลักหลังจากกด Profile Setting

เมื่อผู้ใช้กด `Profile Setting` จาก Rich Menu ให้ bot ตอบด้วย quick reply:

```text
อยากตั้งค่าข้อมูลส่วนไหนครับ

[ตั้งค่าโปรไฟล์]
[ดูโปรไฟล์]
[ตั้งค่า HR Zone]
[แก้ Max HR]
[แก้ Resting HR]
```

คำแนะนำ:

- `ตั้งค่าโปรไฟล์` ใช้สำหรับ onboarding เต็ม
- `ดูโปรไฟล์` แสดงค่าที่บันทึกไว้
- `ตั้งค่า HR Zone` ใช้คำนวณ HR Zone ใหม่จากข้อมูลหัวใจ
- `แก้ Max HR` แก้ค่าเดียวแบบเร็ว
- `แก้ Resting HR` แก้ค่าเดียวแบบเร็ว

## Flow 1: ตั้งค่าโปรไฟล์แบบเต็ม

ใช้เมื่อผู้ใช้กด `ตั้งค่าโปรไฟล์`

### Step 1: ชื่อที่อยากให้ coach เรียก

Bot:

```text
อยากให้ coach เรียกชื่อว่าอะไรครับ
```

User:

```text
ภาวิน
```

Validation:

- ความยาว 1-40 ตัวอักษร
- trim ช่องว่างหัวท้าย
- ถ้าผู้ใช้ส่ง sticker/image ให้ตอบให้พิมพ์เป็นข้อความ

### Step 2: อายุ

Bot:

```text
อายุกี่ปีครับ
```

Validation:

- เป็นตัวเลขจำนวนเต็ม
- ช่วงที่รับได้: 10-90
- ถ้าไม่ผ่านให้ตอบ:

```text
ขอเป็นตัวเลขอายุ เช่น 35 ครับ
```

### Step 3: Resting HR

Bot:

```text
Resting HR ประมาณกี่ bpm ครับ
ถ้าไม่รู้ กด "ยังไม่รู้" ได้ครับ
```

Quick Reply:

```text
[ยังไม่รู้]
```

Validation:

- ถ้ากรอกตัวเลข รับช่วง 35-100 bpm
- ถ้าเลือก `ยังไม่รู้` ให้บันทึกเป็น `null`

Default:

- ถ้าไม่รู้ ให้ใช้ค่า fallback สำหรับการคำนวณบางส่วนเป็น `60`
- แต่ต้องเก็บว่าเป็นค่า estimate ไม่ใช่ค่าจริง

### Step 4: Max HR

Bot:

```text
Max HR สูงสุดที่เคยเห็นประมาณกี่ bpm ครับ
ถ้าไม่รู้ กด "คำนวณจากอายุ" ได้ครับ
```

Quick Reply:

```text
[คำนวณจากอายุ]
```

Validation:

- ถ้ากรอกตัวเลข รับช่วง 120-230 bpm
- ถ้าเลือกคำนวณจากอายุ ให้ใช้สูตร:

```text
estimated_max_hr = 220 - age
```

หมายเหตุ:

- ในอนาคตอาจเปลี่ยนเป็นสูตร `208 - 0.7 * age` ได้ แต่ MVP ใช้ `220 - age` เพราะผู้ใช้เข้าใจง่าย
- ต้องเก็บว่า Max HR เป็น `manual` หรือ `estimated`

### Step 5: เป้าหมายหลัก

Bot:

```text
ตอนนี้เป้าหมายหลักคืออะไรครับ
```

Quick Reply:

```text
[ลดไขมัน]
[วิ่ง 10K]
[Half Marathon]
[Marathon]
[สุขภาพ]
```

ค่าที่เก็บ:

```text
fat_loss
run_10k
half_marathon
marathon
health
```

### Step 6: วันซ้อมต่อสัปดาห์

Bot:

```text
ปกติอยากซ้อมกี่วันต่อสัปดาห์ครับ
```

Quick Reply:

```text
[3 วัน]
[4 วัน]
[5 วัน]
[6 วัน]
```

Validation:

- รับ 1-7
- quick reply ใช้ 3-6 เป็นตัวเลือกหลัก

### Step 7: สรุปและยืนยัน

Bot ส่ง rich message หรือข้อความสรุป:

```text
โปรไฟล์ของคุณ

ชื่อ: ภาวิน
อายุ: 35
Resting HR: 58 bpm
Max HR: 185 bpm
เป้าหมาย: Half Marathon
ซ้อมต่อสัปดาห์: 4 วัน

HR Zone:
Zone 1: 108-121 bpm ฟื้นฟู
Zone 2: 122-140 bpm วิ่งสบาย สร้างฐาน
Zone 3: 141-158 bpm เทมโปเบา
Zone 4: 159-176 bpm หนัก ช่วยความเร็ว
Zone 5: 177-185 bpm หนักมาก ใช้เป็นช่วงสั้น ๆ
```

Quick Reply:

```text
[บันทึก]
[แก้ไขใหม่]
```

เมื่อกด `บันทึก`:

```text
บันทึกโปรไฟล์แล้วครับ
ต่อไป coach จะใช้ HR Zone นี้ตอนสรุปผลวิ่งและแนะนำการซ้อม
```

## Flow 2: ดูโปรไฟล์

ใช้เมื่อผู้ใช้กด `ดูโปรไฟล์`

ถ้ามีข้อมูลแล้ว ให้แสดง rich message:

```text
Profile

ชื่อ: ภาวิน
อายุ: 35
Resting HR: 58 bpm
Max HR: 185 bpm
เป้าหมาย: Half Marathon
ซ้อมต่อสัปดาห์: 4 วัน

HR Zone หลัก:
Zone 2: 122-140 bpm
```

Quick Reply:

```text
[แก้โปรไฟล์]
[แก้ HR Zone]
[แก้เป้าหมาย]
```

ถ้ายังไม่มีข้อมูล:

```text
ยังไม่มีโปรไฟล์ครับ
ตั้งค่าโปรไฟล์ก่อน เพื่อให้ coach แนะนำได้แม่นขึ้น
```

Quick Reply:

```text
[ตั้งค่าโปรไฟล์]
```

## Flow 3: ตั้งค่า HR Zone

ใช้เมื่อผู้ใช้ต้องการตั้งเฉพาะหัวใจ

### แบบง่าย

Bot ถาม:

```text
รู้ค่า Resting HR และ Max HR ไหมครับ
```

Quick Reply:

```text
[รู้ทั้งคู่]
[รู้แค่ Max HR]
[ไม่รู้]
```

### กรณีรู้ทั้งคู่

ถาม Resting HR และ Max HR แล้วคำนวณ zone ด้วย Karvonen method

```text
HRR = Max HR - Resting HR
Zone target = Resting HR + HRR * percentage
```

Zone ที่ใช้:

```text
Zone 1: 50-60%
Zone 2: 60-70%
Zone 3: 70-80%
Zone 4: 80-90%
Zone 5: 90-100%
```

### กรณีรู้แค่ Max HR

คำนวณจากเปอร์เซ็นต์ของ Max HR:

```text
Zone 1: 50-60% max
Zone 2: 60-70% max
Zone 3: 70-80% max
Zone 4: 80-90% max
Zone 5: 90-100% max
```

### กรณีไม่รู้

ใช้:

```text
Max HR = 220 - age
Resting HR = null
calculation_method = estimated
```

Bot ต้องบอกผู้ใช้ให้ชัด:

```text
ตอนนี้เป็นโซนประมาณการจากอายุครับ
ถ้ามี Max HR จริงในอนาคต แนะนำให้กลับมาแก้เพื่อให้แม่นขึ้น
```

## HR Zone Calculation Rules

ลำดับความแม่น:

1. `manual_zones` ถ้าผู้ใช้กรอก zone เองในอนาคต
2. `karvonen` ถ้ามี Resting HR และ Max HR
3. `max_hr_percent` ถ้ามีแค่ Max HR
4. `age_estimated` ถ้ามีแค่อายุ

ค่า zone ควรเก็บเป็นตัวเลข min/max bpm:

```text
zone1_min
zone1_max
zone2_min
zone2_max
zone3_min
zone3_max
zone4_min
zone4_max
zone5_min
zone5_max
```

การปัดเศษ:

- ใช้ `Math.round`
- zone ถัดไปควรเริ่มจาก `previous_max + 1` เพื่อลด overlap

ตัวอย่าง:

```text
Zone 1: 108-121
Zone 2: 122-140
```

## Database Design

แนะนำเพิ่มตารางใหม่ชื่อ `user_profiles`

```sql
CREATE TABLE IF NOT EXISTS user_profiles (
  line_user_id TEXT PRIMARY KEY,
  display_name TEXT,
  age INTEGER,
  resting_hr INTEGER,
  max_hr INTEGER,
  max_hr_source TEXT,
  goal_type TEXT,
  training_days_per_week INTEGER,
  hr_zone_method TEXT,
  hr_zones JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

ค่า enum ที่ควรใช้:

```text
max_hr_source:
- manual
- estimated

goal_type:
- fat_loss
- run_10k
- half_marathon
- marathon
- health

hr_zone_method:
- karvonen
- max_hr_percent
- age_estimated
- manual
```

ตัวอย่าง `hr_zones`:

```json
{
  "zone1": { "min": 108, "max": 121, "label": "ฟื้นฟู" },
  "zone2": { "min": 122, "max": 140, "label": "วิ่งสบาย สร้างฐาน" },
  "zone3": { "min": 141, "max": 158, "label": "เทมโปเบา" },
  "zone4": { "min": 159, "max": 176, "label": "หนัก ช่วยความเร็ว" },
  "zone5": { "min": 177, "max": 185, "label": "หนักมาก ใช้เป็นช่วงสั้น ๆ" }
}
```

## Workflow Session

ให้ใช้ DB-backed workflow session แบบเดียวกับ Weight Training

ตัวอย่าง session:

```json
{
  "flow": "profile_setting",
  "step": "age",
  "data": {
    "display_name": "ภาวิน"
  }
}
```

Step ที่ควรรองรับ:

```text
display_name
age
resting_hr
max_hr
goal_type
training_days
confirm
```

ควรมี timeout:

- ถ้า session ค้างเกิน 24 ชั่วโมง ให้เริ่ม flow ใหม่
- ถ้าผู้ใช้พิมพ์ `ยกเลิก` ให้ลบ session

## Action Mapping

เพิ่มหรือยืนยัน mapping ต่อไปนี้ใน `normalizeMenuAction`

```text
action=profile_setting -> profile_setting
action=profile_setup -> profile_setup
action=profile_view -> profile_view
action=profile_hr_zone -> profile_hr_zone
action=profile_max_hr -> profile_max_hr
action=profile_resting_hr -> profile_resting_hr
action=profile_goal -> profile_goal
```

ข้อความ alias ที่ควรรองรับ:

```text
ตั้งค่าโปรไฟล์
ดูโปรไฟล์
ตั้งค่า HR Zone
แก้ Max HR
แก้ Resting HR
แก้เป้าหมาย
```

## Integration With Other Features

### Stat

เมื่อสรุปผลวิ่ง ให้ใช้ HR Zone จาก `user_profiles.hr_zones`

ถ้ามี average HR:

```text
avg_hr = 148
zone = findZone(avg_hr, user.hr_zones)
```

แสดง:

```text
HR เฉลี่ย: 148 bpm
Zone หลัก: Zone 3 เทมโปเบา
```

### Rich Message ผลวิ่ง

เพิ่ม HR zone bar โดยใช้ zone ของผู้ใช้

Fallback:

- ถ้าไม่มี profile ให้ใช้ zone estimate จากอายุถ้ามี
- ถ้าไม่มีอายุ ให้แสดงแค่ HR เฉลี่ย ไม่ต้องเดา zone

### Today Coach

ใช้ profile เป็น context:

```text
ชื่อ
เป้าหมาย
training days per week
HR Zone
```

ตัวอย่าง prompt context:

```text
User profile:
Name: ภาวิน
Goal: half_marathon
Training days/week: 4
HR Zone 2: 122-140 bpm
```

### Training Plan

ใช้ HR Zone แนะนำ intensity:

```text
Easy Run = Zone 2
Tempo = Zone 3-4
Interval = Zone 4-5
Recovery = Zone 1-2
```

### Weight Training

ยังไม่ต้องผูกเยอะในรอบแรก

แต่อนาคตอาจใช้ goal:

- `marathon` หรือ `half_marathon` ให้เน้นกันเจ็บ/ขา/core
- `fat_loss` ให้เพิ่ม full body strength ได้

## UX Copy

ใช้ภาษาสั้น เป็นมิตร ไม่เทคนิคเกินไป

คำอธิบาย HR Zone:

```text
Zone 1 = ฟื้นฟู
Zone 2 = วิ่งสบาย สร้างฐาน
Zone 3 = เทมโปเบา
Zone 4 = หนัก ช่วยความเร็ว
Zone 5 = หนักมาก ใช้เป็นช่วงสั้น ๆ
```

ข้อความเตือน:

```text
HR Zone นี้เป็นค่าประมาณ ไม่ใช่คำแนะนำทางการแพทย์
ถ้ามีโรคประจำตัวหรืออาการผิดปกติ ควรปรึกษาแพทย์ก่อนซ้อมหนัก
```

อย่าใช้ข้อความที่ทำให้ผู้ใช้กลัว เช่น:

```text
หัวใจผิดปกติ
อันตราย
ห้ามวิ่ง
```

ให้ใช้ภาษาประเมินแบบปลอดภัย:

```text
วันนี้ HR สูงกว่าปกติ แนะนำลดความหนักและสังเกตอาการ
```

## Rich Message: Profile Summary

ควรเป็น Flex Message 1 bubble

โครง:

```text
Header:
Profile Setting

Body:
ชื่อ / อายุ / เป้าหมาย
Resting HR / Max HR

HR Zone:
Zone 1: xxx-xxx
Zone 2: xxx-xxx
Zone 3: xxx-xxx
Zone 4: xxx-xxx
Zone 5: xxx-xxx

Footer buttons:
[แก้โปรไฟล์]
[แก้ HR Zone]
```

สี:

- Zone 1: เทา/ฟ้าอ่อน
- Zone 2: เขียว
- Zone 3: เหลือง
- Zone 4: ส้ม
- Zone 5: แดง

## Validation Rules

```text
age: 10-90
resting_hr: 35-100
max_hr: 120-230
training_days_per_week: 1-7
display_name: 1-40 chars
```

Cross-field validation:

```text
max_hr ต้องมากกว่า resting_hr อย่างน้อย 40 bpm
ถ้า max_hr <= resting_hr ให้ถามใหม่
```

ตัวอย่างข้อความ:

```text
Max HR ควรมากกว่า Resting HR ค่อนข้างชัดครับ
ลองใส่ Max HR ใหม่อีกครั้ง เช่น 185
```

## Error Handling

ถ้า database fail:

```text
ตอนนี้บันทึกโปรไฟล์ไม่ได้ครับ ลองใหม่อีกครั้งในอีกสักครู่
```

ถ้า user ส่ง input ผิดซ้ำ 3 ครั้ง:

```text
เดี๋ยวเริ่มใหม่ให้ง่ายขึ้นนะครับ
```

แล้วกลับไป step ปัจจุบันพร้อม quick reply

ถ้า user พิมพ์ `ยกเลิก`:

```text
ยกเลิกการตั้งค่าแล้วครับ
กลับมาเริ่มใหม่ได้จาก Profile Setting
```

## Privacy And Security

ข้อมูล profile ถือเป็นข้อมูลส่วนตัว

ข้อควรทำ:

- ห้าม log profile แบบเต็มใน production
- ห้ามส่งข้อมูล profile ไปที่ third party ยกเว้น AI prompt ที่จำเป็นต่อคำตอบ
- ถ้าส่งเข้า AI prompt ให้ส่งเฉพาะข้อมูลที่จำเป็น เช่น age, goal, HR Zone ไม่ต้องส่งทุก field เสมอ
- ห้ามเปิดเผย LINE user id ในข้อความตอบกลับ

## Implementation Plan

### Phase 1: LINE-only Profile Flow

ทำใน LINE chat ก่อน ยังไม่ต้องทำ LIFF

งานที่ต้องทำ:

```text
1. เพิ่ม migration user_profiles
2. เพิ่ม repository สำหรับ profile
3. เพิ่ม helper คำนวณ HR Zone
4. เพิ่ม Profile Setting workflow session
5. เพิ่ม rich message profile summary
6. เชื่อม Stat ให้ใช้ HR Zone
7. เพิ่ม test
```

ผลลัพธ์:

- ผู้ใช้ตั้งค่า profile ได้
- ดู profile ได้
- HR Zone ถูกใช้ใน Stat และ rich message ได้

### Phase 2: Better Profile UX

เพิ่มความสะดวก:

```text
1. แก้ field เดียว เช่น Max HR, Resting HR, goal
2. แสดง profile completeness
3. แนะนำให้กรอกข้อมูลที่ยังขาด
4. เพิ่ม HR Zone bar ใน run result เต็มรูปแบบ
```

### Phase 3: LIFF / Mini Web

ทำเมื่อ flow ใน LINE เริ่มเยอะเกิน

เหมาะสำหรับ:

```text
แก้หลาย field ในหน้าเดียว
ตั้ง zone เอง
ดูกราฟ HR Zone
ตั้ง race goal และวันแข่ง
```

ยังไม่จำเป็นในรอบแรก

## Suggested Files To Touch

คาดว่า implementation จะเกี่ยวกับไฟล์เหล่านี้:

```text
index.js
src/db/migrations.js
src/repositories/profileRepository.js
src/services/profileService.js
src/utils/hrZones.js
tests/workflow-static.test.js
docs/profile-setting-workflow.md
```

ถ้าโปรเจกต์ยังรวม logic ไว้ใน `index.js` เยอะ ให้เริ่มแบบเล็กก่อน:

```text
1. helper คำนวณ zone แยกไฟล์ได้
2. repository แยกไฟล์ได้
3. handler จะยังอยู่ใน index.js ก็ได้ ถ้าต้องการ patch เล็ก
```

## Acceptance Criteria

ถือว่า feature เสร็จเมื่อ:

- กด `Profile Setting` แล้วเห็นตัวเลือก profile
- กด `ตั้งค่าโปรไฟล์` แล้ว bot ถามครบทุก step
- input ผิดแล้ว bot ถามซ้ำแบบเข้าใจง่าย
- กด `บันทึก` แล้วข้อมูลลง database
- กด `ดูโปรไฟล์` แล้วเห็นข้อมูลล่าสุด
- HR Zone ถูกคำนวณถูกต้อง
- Stat หรือ run summary ใช้ HR Zone จาก profile
- Render restart แล้ว session ที่ยังไม่จบไม่หาย
- มี test ครอบคลุม action mapping และ happy path

## Test Cases

### Happy Path

```text
Profile Setting
ตั้งค่าโปรไฟล์
ภาวิน
35
58
185
Half Marathon
4 วัน
บันทึก
```

Expected:

```text
profile saved
hr_zones exists
profile_view shows saved values
```

### Estimated HR Path

```text
Profile Setting
ตั้งค่าโปรไฟล์
ภาวิน
35
ยังไม่รู้
คำนวณจากอายุ
สุขภาพ
3 วัน
บันทึก
```

Expected:

```text
max_hr = 185
max_hr_source = estimated
hr_zone_method = age_estimated or max_hr_percent
bot tells user this is estimated
```

### Invalid Input

```text
age = abc
resting_hr = 300
max_hr = 80
```

Expected:

```text
bot asks again
session remains same step
no bad data saved
```

### Cancel

```text
ตั้งค่าโปรไฟล์
ภาวิน
ยกเลิก
```

Expected:

```text
workflow session deleted
profile unchanged
```

## Rollout Plan

1. ทำใน branch แยก
2. เพิ่ม migration
3. deploy Render
4. เช็ก `/health`
5. ทดสอบกับ LINE account จริง 1 คน
6. กด Profile Setting จาก Rich Menu
7. ตั้งค่า profile และดู profile
8. ส่งผลวิ่งหรือดู Stat เพื่อเช็กว่า HR Zone ถูกใช้

## สิ่งที่ยังไม่ต้องทำตอนนี้

ยังไม่ต้องทำ:

- coaching engine เต็ม
- LIFF เต็มรูปแบบ
- race calendar
- training plan generator รายเดือน
- manual HR zone editor แบบละเอียด

เหตุผล:

Profile Setting ต้องเป็นฐานข้อมูลที่นิ่งก่อน แล้วค่อยให้ coaching engine ใช้ต่อ
