// Links that only show once they lead somewhere: the app's address and a contact email come
// from the environment, and in development the placeholders stand in so the page looks whole.
const dev = process.env.NODE_ENV !== "production";
const email = process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? (dev ? "hello@binarylabs.example" : null);

export const APP_URL: string | null = process.env.NEXT_PUBLIC_APP_URL ?? (dev ? "http://localhost:3000" : null);
export const PILOT_MAILTO: string | null = email === null ? null : `mailto:${email}?subject=Pilot%20request`;
export const CALL_MAILTO: string | null = email === null ? null : `mailto:${email}?subject=Book%20a%20call`;

// "#" until the accounts exist; an icon shows only once its link is real (in development, all show).
export const SOCIAL = {
  linkedin: "#",
  instagram: "#",
  email: "#",
  youtube: "#",
} as const;

export const SOCIAL_SHOWN = (Object.keys(SOCIAL) as (keyof typeof SOCIAL)[]).filter((key) => dev || SOCIAL[key] !== "#");
