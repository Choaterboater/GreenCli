/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Semantic tokens (resolve to CSS variables — theme-aware)
        accent: 'var(--accent)',
        'accent-hover': 'var(--accent-hover)',
        'accent-2': 'var(--accent-2)',
        ok: 'var(--accent-success)',
        warn: 'var(--accent-warning)',
        danger: 'var(--accent-danger)',
        info: 'var(--accent-info)',
        // Vendor identity
        'vendor-hpe': 'var(--vendor-hpe)',
        'vendor-aruba': 'var(--vendor-aruba)',
        'vendor-juniper': 'var(--vendor-juniper)',
        'vendor-mist': 'var(--vendor-mist)',
        'vendor-generic': 'var(--vendor-generic)',
        // Brand literals (HPE)
        'hpe-green': '#01a982',
        'aruba-orange': '#ff8300',
        'juniper-green': '#84b135',
        'mist-violet': '#7b61ff',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Consolas', 'monospace'],
      },
      boxShadow: {
        'elevation-1': 'var(--elevation-1)',
        'elevation-2': 'var(--elevation-2)',
        'elevation-3': 'var(--elevation-3)',
        'glow-accent': 'var(--glow-accent)',
      },
      borderRadius: {
        DEFAULT: 'var(--radius)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
    },
  },
  plugins: [],
}
