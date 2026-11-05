import type { MetadataRoute } from "next";

// Installable from the browser, so a phone at the bench opens straight to the app. No service
// worker: install doesn't need one, and lab content must not sit in an offline cache.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Binary",
    short_name: "Binary",
    description: "Search everything your lab has made.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#151516",
    theme_color: "#151516",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [{ name: "Upload", short_name: "Upload", url: "/upload", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] }],
  };
}
