/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        vscode: {
          bg: "var(--vscode-editor-background)",
          fg: "var(--vscode-editor-foreground)",
          border: "var(--vscode-panel-border)",
          inputBg: "var(--vscode-input-background)",
          inputFg: "var(--vscode-input-foreground)",
          inputBorder: "var(--vscode-input-border)",
          buttonBg: "var(--vscode-button-background)",
          buttonFg: "var(--vscode-button-foreground)",
          buttonHover: "var(--vscode-button-hoverBackground)",
          sidebarBg: "var(--vscode-sideBar-background)",
          badgeBg: "var(--vscode-badge-background)",
          badgeFg: "var(--vscode-badge-foreground)",
          linkFg: "var(--vscode-textLink-foreground)",
          errorFg: "var(--vscode-errorForeground)",
          descriptionFg: "var(--vscode-descriptionForeground)",
        },
      },
    },
  },
  plugins: [],
};
