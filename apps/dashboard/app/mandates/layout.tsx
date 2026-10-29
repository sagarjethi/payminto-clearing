import type { Metadata } from "next";

export const metadata: Metadata = { title: { absolute: "Mandates - Payminto Clearing" } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
