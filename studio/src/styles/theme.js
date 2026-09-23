const studioPreset = {
  theme: {
    extend: {
      colors: {
        studio: {
          bg: "#0a0a0a",
          surface: "rgb(74, 74, 74)",
          border: "#262626",
          text: "#e5e5e5",
          muted: "#737373",
          accent: "#2D7FFFFF",
        },
        panel: {
          bg: "#0C0C0E",
          // Open inspector-section body — slightly lighter than headers (bg)
          // so the recessed scrollable region reads distinct.
          "bg-inset": "#121214",
          input: "#161618",
          surface: "#18181B",
          hover: "#27272A",
          border: "#1E1E1E",
          "border-input": "#27272A",
          hairline: "#1A1A1C",
          "text-0": "#FAFAFA",
          "text-1": "#E4E4E7",
          "text-2": "#A1A1AA",
          "text-3": "#71717A",
          "text-4": "#52525B",
          "text-5": "#3F3F46",
          accent: "#2D7FFFFF",
          danger: "#EF4444",
          media: "#00E3FF",
          container: "#F5A623",
        },
      },
    },
  },
  plugins: [],
};

export default studioPreset;
