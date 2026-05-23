const HR_ZONE_LABELS = {
  zone1: "ฟื้นฟู",
  zone2: "วิ่งสบาย สร้างฐาน",
  zone3: "เทมโปเบา",
  zone4: "หนัก ช่วยความเร็ว",
  zone5: "หนักมาก ใช้เป็นช่วงสั้น ๆ",
};

const HR_ZONE_COLORS = {
  zone1: "#E0F2FE",
  zone2: "#DCFCE7",
  zone3: "#FEF9C3",
  zone4: "#FFEDD5",
  zone5: "#FEE2E2",
};

const HR_ZONE_TEXT_COLORS = {
  zone1: "#0369A1",
  zone2: "#15803D",
  zone3: "#A16207",
  zone4: "#C2410C",
  zone5: "#B91C1C",
};

function toInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function makeZoneRange(min, max, labelKey) {
  return {
    min: Math.round(min),
    max: Math.round(max),
    label: HR_ZONE_LABELS[labelKey],
  };
}

function normalizeSequentialZones(rawZones) {
  const keys = ["zone1", "zone2", "zone3", "zone4", "zone5"];
  const zones = {};
  let previousMax = null;

  for (const key of keys) {
    const raw = rawZones[key];
    const min = previousMax === null ? Math.round(raw.min) : previousMax + 1;
    const max = Math.max(min, Math.round(raw.max));
    zones[key] = {
      min,
      max,
      label: HR_ZONE_LABELS[key],
    };
    previousMax = max;
  }

  return zones;
}

function calculateHrZones({ age, restingHr, maxHr }) {
  const normalizedAge = toInteger(age);
  const normalizedRestingHr = toInteger(restingHr);
  const normalizedMaxHr = toInteger(maxHr) || (normalizedAge ? 220 - normalizedAge : null);

  if (!normalizedMaxHr) {
    return {
      method: null,
      maxHr: null,
      maxHrSource: null,
      restingHr: normalizedRestingHr,
      zones: {},
    };
  }

  if (normalizedRestingHr) {
    const hrr = normalizedMaxHr - normalizedRestingHr;
    return {
      method: "karvonen",
      maxHr: normalizedMaxHr,
      maxHrSource: maxHr ? "manual" : "estimated",
      restingHr: normalizedRestingHr,
      zones: normalizeSequentialZones({
        zone1: makeZoneRange(normalizedRestingHr + hrr * 0.5, normalizedRestingHr + hrr * 0.6, "zone1"),
        zone2: makeZoneRange(normalizedRestingHr + hrr * 0.6, normalizedRestingHr + hrr * 0.7, "zone2"),
        zone3: makeZoneRange(normalizedRestingHr + hrr * 0.7, normalizedRestingHr + hrr * 0.8, "zone3"),
        zone4: makeZoneRange(normalizedRestingHr + hrr * 0.8, normalizedRestingHr + hrr * 0.9, "zone4"),
        zone5: makeZoneRange(normalizedRestingHr + hrr * 0.9, normalizedMaxHr, "zone5"),
      }),
    };
  }

  return {
    method: maxHr ? "max_hr_percent" : "age_estimated",
    maxHr: normalizedMaxHr,
    maxHrSource: maxHr ? "manual" : "estimated",
    restingHr: null,
    zones: normalizeSequentialZones({
      zone1: makeZoneRange(normalizedMaxHr * 0.5, normalizedMaxHr * 0.6, "zone1"),
      zone2: makeZoneRange(normalizedMaxHr * 0.6, normalizedMaxHr * 0.7, "zone2"),
      zone3: makeZoneRange(normalizedMaxHr * 0.7, normalizedMaxHr * 0.8, "zone3"),
      zone4: makeZoneRange(normalizedMaxHr * 0.8, normalizedMaxHr * 0.9, "zone4"),
      zone5: makeZoneRange(normalizedMaxHr * 0.9, normalizedMaxHr, "zone5"),
    }),
  };
}

function findHrZone(hr, zones = {}) {
  const value = toInteger(hr);
  if (!value) return null;

  for (const [key, zone] of Object.entries(zones)) {
    if (value >= Number(zone.min) && value <= Number(zone.max)) {
      return { key, ...zone };
    }
  }

  return null;
}

function validateProfileInput(profile = {}) {
  const errors = {};
  const displayName = String(profile.displayName || profile.display_name || "").trim();
  const age = toInteger(profile.age);
  const restingHr = toInteger(profile.restingHr ?? profile.resting_hr);
  const maxHr = toInteger(profile.maxHr ?? profile.max_hr);
  const effectiveMaxHr = maxHr || (age ? 220 - age : null);
  const trainingDays = toInteger(profile.trainingDaysPerWeek ?? profile.training_days_per_week);
  const goalType = String(profile.goalType || profile.goal_type || "").trim();

  if (!displayName || displayName.length > 40) {
    errors.displayName = "ชื่อควรยาว 1-40 ตัวอักษร";
  }
  if (!age || age < 10 || age > 90) {
    errors.age = "อายุควรอยู่ระหว่าง 10-90 ปี";
  }
  if (restingHr !== null && (restingHr < 35 || restingHr > 100)) {
    errors.restingHr = "Resting HR ควรอยู่ระหว่าง 35-100 bpm";
  }
  if (maxHr !== null && (maxHr < 120 || maxHr > 230)) {
    errors.maxHr = "Max HR ควรอยู่ระหว่าง 120-230 bpm";
  }
  if (restingHr !== null && effectiveMaxHr !== null && effectiveMaxHr <= restingHr + 39) {
    errors.maxHr = "Max HR ควรมากกว่า Resting HR อย่างน้อย 40 bpm";
  }
  if (!trainingDays || trainingDays < 1 || trainingDays > 7) {
    errors.trainingDaysPerWeek = "วันซ้อมควรอยู่ระหว่าง 1-7 วันต่อสัปดาห์";
  }
  if (!["fat_loss", "run_10k", "half_marathon", "marathon", "health"].includes(goalType)) {
    errors.goalType = "เลือกเป้าหมายหลักก่อนครับ";
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    value: {
      displayName,
      age,
      restingHr,
      maxHr,
      goalType,
      trainingDaysPerWeek: trainingDays,
    },
  };
}

module.exports = {
  HR_ZONE_LABELS,
  HR_ZONE_COLORS,
  HR_ZONE_TEXT_COLORS,
  calculateHrZones,
  findHrZone,
  validateProfileInput,
};
