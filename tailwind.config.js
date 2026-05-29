/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'aruba-blue': '#58a6ff',
        'aruba-green': '#238636',
        'aruba-yellow': '#d29922',
        'aruba-red': '#da3633',
        'dark-bg': '#0d1117',
        'dark-bg-secondary': '#161b22',
        'dark-bg-tertiary': '#21262d',
        'dark-text': '#c9d1d9',
        'dark-text-secondary': '#8b949e',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
}
