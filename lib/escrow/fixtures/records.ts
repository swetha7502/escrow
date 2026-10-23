// Fake student records for demos and tests. All data is synthetic. Canaries are unique honeytokens.
import type { Policy, StudentRecord } from "../verify.ts";

export const RECORDS: StudentRecord[] = [
  {
    studentId: "PSU-90412277", name: "Avery Quill", email: "avery.quill@student.example.edu",
    sensitive: { grade: "Midterm 61/100 (D)", dob: "2005-03-14", accommodation: "Extended time 1.5x (ODS-4471)" },
    canary: "CNRY-7Q4X-AVERY-91",
  },
  {
    studentId: "PSU-90418830", name: "Jordan Pike", email: "jordan.pike@student.example.edu",
    sensitive: { grade: "Midterm 88/100 (B+)", dob: "2004-11-02", accommodation: "None on file" },
    canary: "CNRY-K2M8-JORDAN-37",
  },
  {
    studentId: "PSU-90420015", name: "Sam Okafor", email: "sam.okafor@student.example.edu",
    sensitive: { grade: "Midterm 74/100 (C)", dob: "2005-07-29", accommodation: "Reduced-distraction room (ODS-5120)" },
    canary: "CNRY-Z9P1-SAM-58",
  },
];

export const POLICY: Policy = {
  records: RECORDS,
  officials: ["prof.lin@example.edu", "ta.rivera@example.edu"],
};
