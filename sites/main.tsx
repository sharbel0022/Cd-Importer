import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import MusicApp from "../src/components/music-app";
import "../src/app/globals.css";
createRoot(document.getElementById("root")!).render(<StrictMode><MusicApp /></StrictMode>);
