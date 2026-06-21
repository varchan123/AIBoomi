import type { Config } from "tailwindcss";

export default {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: "#13221d",
        moss: "#1f6f54",
        mint: "#dff4e9",
        sand: "#f5f1e8",
        amber: "#d98b2b"
      },
      boxShadow: {
        card: "0 18px 50px rgba(19, 34, 29, 0.08)"
      }
    },
  },
  plugins: [],
} satisfies Config;
