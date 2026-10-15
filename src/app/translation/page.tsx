import type { Metadata } from "next";
import TranslationStudio from "@/components/translation-studio";
import "./translation.css";
export const metadata: Metadata = { title: "AI Translation Studio · TON" };
export default function TranslationPage() { return <TranslationStudio />; }
