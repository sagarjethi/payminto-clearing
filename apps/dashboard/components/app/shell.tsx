"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import {
  BookOpenCheck,
  FileSignature,
  Layers,
  LayoutGrid,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Settings,
  ShieldCheck,
  Store,
  Sun,
  Waypoints,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { MOCK_MODE, NODE_URL } from "@/lib/config";
import { useSession } from "@/lib/session";
import { useLive } from "@/lib/live";
import { chainIdOf, useHealth, useInfo } from "@/lib/queries";
import { formatInt } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SignIn } from "./sign-in";

const NAV = [
  { href: "/", label: "Overview", icon: LayoutGrid },
  { href: "/netting", label: "Netting", icon: Waypoints },
  { href: "/mandates", label: "Mandates", icon: FileSignature },
  { href: "/providers", label: "Providers", icon: Store },
  { href: "/batches", label: "Batches", icon: Layers },
  { href: "/receipts", label: "Receipt proof", icon: ShieldCheck },
  { href: "/ledger", label: "Ledger", icon: BookOpenCheck },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

/** Mark: several obligations converging into one settled transfer. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-8", className)}>
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <g fill="none" strokeLinecap="round" strokeWidth="2.2" className="stroke-primary-foreground">
        <path d="M7 9.5c6 0 7.5 6.5 13 6.5" opacity=".55" />
        <path d="M7 22.5c6 0 7.5-6.5 13-6.5" opacity=".55" />
        <path d="M7 16h18" />
        <path d="M21.5 12.5 25 16l-3.5 3.5" />
      </g>
    </svg>
  );
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5 rounded-md">
      <BrandMark />
      <span className="leading-tight">
        <span className="block text-[0.9375rem] font-semibold tracking-[-0.01em]">Payminto Clearing</span>
        <span className="block text-[0.6875rem] text-muted-foreground">Agent payments, cleared on HashKey Chain</span>
      </span>
    </Link>
  );
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex h-9 items-center gap-3 rounded-md px-2.5 text-sm transition-colors",
              active ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" strokeWidth={active ? 2.2 : 1.8} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

function SidebarFooter() {
  const { signOut } = useSession();
  return (
    <div className="space-y-2 border-t pt-4 text-xs text-muted-foreground">
      <div className="px-2.5">
        <p className="text-subtle">Clearing node</p>
        <p className="hash mt-0.5 truncate text-foreground" title={MOCK_MODE ? "In-browser mock node" : NODE_URL}>
          {MOCK_MODE ? "mock (in-browser)" : NODE_URL.replace(/^https?:\/\//, "")}
        </p>
      </div>
      <button
        type="button"
        onClick={signOut}
        className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <LogOut className="size-3.5" /> Sign out
      </button>
    </div>
  );
}

function LiveIndicator() {
  const { status } = useLive();
  const label = status === "live" ? "Live" : status === "connecting" ? "Reconnecting" : "Offline";
  const tone = status === "live" ? "text-positive" : status === "connecting" ? "text-warning" : "text-negative";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex h-8 items-center gap-2 rounded-md px-2 text-xs font-medium text-muted-foreground">
          <span className={cn("relative flex size-2", tone)}>
            {status === "live" && <span className="absolute inset-0 rounded-full bg-current [animation:pulse-ring_2s_ease-out_infinite]" />}
            <span className="relative size-2 rounded-full bg-current" />
          </span>
          <span className="hidden sm:inline">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {status === "live" ? "Receiving events from the clearing node" : status === "connecting" ? "Event stream dropped; retrying" : "No event stream. Screens refresh on demand."}
      </TooltipContent>
    </Tooltip>
  );
}

function NetworkPill() {
  const info = useInfo();
  const health = useHealth();
  if (!info.data) return <span className="h-8 w-40 animate-pulse rounded-md bg-muted" />;
  const chainId = chainIdOf(info.data);
  return (
    <span className="inline-flex h-8 items-center gap-2 rounded-md border bg-card px-2.5 text-xs">
      <span className="font-medium">{info.data.network.name}</span>
      <span className="hidden text-subtle md:inline">chain {chainId}</span>
      {health.data && <span className="num hidden text-muted-foreground lg:inline">block {formatInt(health.data.blockNumber)}</span>}
    </span>
  );
}

function ThemeMenu() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- theme is only known after hydration
  useEffect(() => setMounted(true), []);
  const Icon = !mounted ? Monitor : theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Theme">
          <Icon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuRadioGroup value={mounted ? theme : "system"} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MobileNav() {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="lg:hidden" aria-label="Open navigation">
          <Menu />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="flex w-72 flex-col gap-6 p-4">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <Brand />
        <div className="flex-1">
          <NavList onNavigate={() => setOpen(false)} />
        </div>
        <SidebarFooter />
      </SheetContent>
    </Sheet>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15.5rem_1fr]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2">
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-dvh flex-col gap-7 border-r bg-rail px-3 py-5 lg:flex">
        <div className="px-1.5">
          <Brand />
        </div>
        <div className="flex-1 overflow-y-auto">
          <NavList />
        </div>
        <SidebarFooter />
      </aside>
      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur-md sm:px-6">
          <MobileNav />
          <div className="lg:hidden">
            <Link href="/" aria-label="Payminto Clearing overview" className="flex items-center gap-2">
              <BrandMark className="size-7" />
              <span className="text-sm font-semibold max-[380px]:hidden">Payminto Clearing</span>
            </Link>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            {MOCK_MODE && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className="inline-flex h-6 items-center rounded-md bg-warning-soft px-2 text-xs font-medium text-warning">
                    Mock data
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-64">NEXT_PUBLIC_MOCK=1: an in-browser node with fixtures. Nothing touches a chain.</TooltipContent>
              </Tooltip>
            )}
            <span className="max-sm:hidden">
              <NetworkPill />
            </span>
            <LiveIndicator />
            <ThemeMenu />
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-[1320px] px-4 pt-6 pb-16 sm:px-6 sm:pt-8 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}

export function AppGate({ children }: { children: ReactNode }) {
  const session = useSession();
  if (session.status === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center" aria-busy="true">
        <BrandMark className="size-9 animate-pulse" />
      </div>
    );
  }
  if (session.status === "signed-out") return <SignIn />;
  return <Shell>{children}</Shell>;
}
