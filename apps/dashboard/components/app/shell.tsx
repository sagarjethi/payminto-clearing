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
  Monitor,
  MoreHorizontal,
  Moon,
  Settings,
  ShieldBan,
  ShieldCheck,
  Store,
  Sun,
  Waypoints,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { MOCK_MODE, NODE_URL } from "@/lib/config";
import { useSession } from "@/lib/session";
import { useLive } from "@/lib/live";
import { chainIdOf, useHealth, useInfo, useOverview } from "@/lib/queries";
import { formatInt } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SignIn } from "./sign-in";

type NavItem = { href: string; label: string; icon: typeof LayoutGrid; short?: string; badge?: "denials" };

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Clearing",
    items: [
      { href: "/", label: "Overview", icon: LayoutGrid },
      { href: "/netting", label: "Netting", icon: Waypoints },
      { href: "/batches", label: "Batches", icon: Layers },
    ],
  },
  {
    label: "Controls",
    items: [
      { href: "/mandates", label: "Mandates", icon: FileSignature },
      { href: "/providers", label: "Providers", icon: Store },
      { href: "/denials", label: "Blocked calls", short: "Blocked", icon: ShieldBan, badge: "denials" },
    ],
  },
  {
    label: "Audit",
    items: [
      { href: "/receipts", label: "Receipt proof", short: "Proof", icon: ShieldCheck },
      { href: "/ledger", label: "Ledger", icon: BookOpenCheck },
    ],
  },
];

const SETTINGS: NavItem = { href: "/settings", label: "Settings", icon: Settings };

/** The four destinations a phone gets in its tab bar; everything else lives under More. */
const TABS: NavItem[] = [NAV_GROUPS[0]!.items[0]!, NAV_GROUPS[0]!.items[1]!, NAV_GROUPS[1]!.items[0]!, NAV_GROUPS[1]!.items[2]!];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

function DenialBadge({ className }: { className?: string }) {
  const overview = useOverview();
  const n = overview.data?.denials24h ?? 0;
  if (n <= 0) return null;
  return (
    <span
      className={cn("num inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full bg-negative-soft px-1 text-[0.6875rem] font-semibold text-negative", className)}
      aria-label={`${n} blocked in the last 24 hours`}
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}

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

function NavLink({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  const pathname = usePathname();
  const active = isActive(pathname, item.href);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-9 items-center gap-3 rounded-md px-2.5 text-sm transition-colors",
        active ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" strokeWidth={active ? 2.2 : 1.8} />
      <span className="flex-1 truncate">{item.label}</span>
      {item.badge === "denials" && <DenialBadge />}
    </Link>
  );
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-5">
      {NAV_GROUPS.map((g) => (
        <div key={g.label}>
          <p className="mb-1 px-2.5 text-[0.6875rem] font-medium tracking-[0.06em] text-subtle uppercase">{g.label}</p>
          <div className="flex flex-col gap-0.5">
            {g.items.map((item) => (
              <NavLink key={item.href} item={item} onNavigate={onNavigate} />
            ))}
          </div>
        </div>
      ))}
      <div className="flex flex-col gap-0.5 border-t pt-4">
        <NavLink item={SETTINGS} onNavigate={onNavigate} />
      </div>
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
  const { status, wasLive } = useLive();
  const label = status === "live" ? "Live" : status === "connecting" ? (wasLive ? "Reconnecting" : "Connecting") : "Offline";
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
        {status === "live" ? "Receiving events from the clearing node" : status === "connecting" ? (wasLive ? "Event stream dropped; retrying" : "Opening the event stream") : "No event stream. Screens refresh on demand."}
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
      {health.data?.blockNumber != null && <span className="num hidden text-muted-foreground lg:inline">block {formatInt(health.data.blockNumber)}</span>}
      {health.data && !health.data.ok && <span className="text-negative">RPC unreachable</span>}
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

function MobileSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="flex w-72 flex-col gap-6 overflow-y-auto p-4">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <Brand />
        <div className="flex-1">
          <NavList onNavigate={() => onOpenChange(false)} />
        </div>
        <SidebarFooter />
      </SheetContent>
    </Sheet>
  );
}

/** Phone navigation: the four main destinations one thumb away, the rest under More. */
function TabBar({ onMore }: { onMore: () => void }) {
  const pathname = usePathname();
  const inTabs = TABS.some((t) => isActive(pathname, t.href));
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden"
    >
      <ul className="mx-auto grid h-16 max-w-lg grid-cols-5">
        {TABS.map((t) => {
          const active = isActive(pathname, t.href);
          const Icon = t.icon;
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex h-full flex-col items-center justify-center gap-1 text-[0.6875rem] font-medium",
                  active ? "text-primary" : "text-muted-foreground",
                )}
              >
                <span className="relative">
                  <Icon className="size-5" strokeWidth={active ? 2.2 : 1.8} />
                  {t.badge === "denials" && <DenialBadge className="absolute -top-1.5 left-3.5" />}
                </span>
                {t.short ?? t.label}
              </Link>
            </li>
          );
        })}
        <li>
          <button
            type="button"
            onClick={onMore}
            className={cn("flex h-full w-full flex-col items-center justify-center gap-1 text-[0.6875rem] font-medium", inTabs ? "text-muted-foreground" : "text-primary")}
          >
            <MoreHorizontal className="size-5" strokeWidth={1.8} />
            More
          </button>
        </li>
      </ul>
    </nav>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const [sheetOpen, setSheetOpen] = useState(false);
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
        <main id="main" className="mx-auto w-full max-w-[1320px] px-4 pt-6 pb-28 sm:px-6 sm:pt-8 lg:px-8 lg:pb-16">
          {children}
        </main>
        <TabBar onMore={() => setSheetOpen(true)} />
        <MobileSheet open={sheetOpen} onOpenChange={setSheetOpen} />
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
