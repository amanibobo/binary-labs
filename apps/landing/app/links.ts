export const PILOT_MAILTO = "mailto:hello@binarylabs.example?subject=Pilot%20request";
export const CALL_MAILTO = "mailto:hello@binarylabs.example?subject=Book%20a%20call";
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

// Placeholders until the accounts exist; swap in the real URLs and address.
export const SOCIAL = {
  linkedin: "#",
  instagram: "#",
  email: "#",
  youtube: "#",
} as const;
