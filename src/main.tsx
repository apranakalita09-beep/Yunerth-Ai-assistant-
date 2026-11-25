import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { MemoryProvider } from "./memory/MemoryProvider.tsx";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <MemoryProvider>
      <App />
    </MemoryProvider>
  </ErrorBoundary>
);
