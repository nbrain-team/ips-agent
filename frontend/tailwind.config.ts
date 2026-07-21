import type { Config } from "tailwindcss";

/**
 * IPS brand tokens — sampled from ipsaecorp.com theme CSS + ips-logo.png:
 * red #EC1C24 (primary), dark red #C41725 (hover), charcoal #231F20,
 * site darks #262626/#0F0F0F, steel-blue accent #465596, neutrals #F2F2F2/#E0E0E0.
 * Font: "Kumbh Sans" (site-wide).
 */
const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        "ips-red": {
          DEFAULT: "#EC1C24",
          dark: "#C41725",
          soft: "#FDE8E9",
        },
        "ips-charcoal": {
          DEFAULT: "#231F20",
          800: "#262626",
          900: "#0F0F0F",
          600: "#4C4C4C",
        },
        "ips-steel": {
          DEFAULT: "#465596",
          soft: "#E9EAEE",
        },
        "ips-surface": "#F2F2F2",
        "ips-border": "#E0E0E0",
      },
      fontFamily: {
        sans: ['"Kumbh Sans"', "Arial", "Helvetica", "sans-serif"],
      },
      keyframes: {
        "pulse-dot": {
          "0%, 80%, 100%": { opacity: "0.25", transform: "scale(0.85)" },
          "40%": { opacity: "1", transform: "scale(1)" },
        },
      },
      animation: {
        "pulse-dot": "pulse-dot 1.2s ease-in-out infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
