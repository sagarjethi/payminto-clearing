import type { Metadata } from "next";

export const metadata: Metadata = { title: { absolute: "Batches - Payminto Clearing" } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
