export const DEMO_TIMELINE_MS = [15000, 25000, 35000];

export const DEMO_SCANS = [
  {
    trust_score: 94,
    verdict: "likely_authentic",
    deepfake_probability: 0.06,
    faces_detected: 1,
    flagged_timestamps: [],
    scan_id: "demo_001"
  },
  {
    trust_score: 58,
    verdict: "uncertain",
    deepfake_probability: 0.42,
    faces_detected: 1,
    flagged_timestamps: [
      {
        start: 3.1,
        end: 4.5,
        reason: "Minor lip-sync drift"
      }
    ],
    scan_id: "demo_002"
  },
  {
    trust_score: 22,
    verdict: "likely_deepfake",
    deepfake_probability: 0.78,
    faces_detected: 1,
    flagged_timestamps: [
      {
        start: 1.2,
        end: 2.8,
        reason: "Face boundary inconsistency"
      },
      {
        start: 4.6,
        end: 6.3,
        reason: "Lip-sync drift exceeds 150ms"
      },
      {
        start: 7.1,
        end: 9.4,
        reason: "Blink pattern irregularity"
      }
    ],
    scan_id: "demo_003"
  }
];

export function cloneDemoScan(index) {
  return JSON.parse(JSON.stringify(DEMO_SCANS[index]));
}
