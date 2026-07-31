import type { Config } from "tailwindcss";

export default {
  content: ["./src/renderer/**/*.{html,tsx,ts}"],
  theme: {
    extend: {
      colors: {
        bg: { DEFAULT: "#09090b", secondary: "#18181b" },
        border: { DEFAULT: "#27272a" },
      },
    },
  },
  plugins: [],
} satisfies Config;
