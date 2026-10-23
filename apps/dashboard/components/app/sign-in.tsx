"use client";

import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { checkToken, ApiError } from "@/lib/api";
import { LOCAL_DEFAULT_TOKEN, MOCK_MODE, NODE_URL, isLocalNode } from "@/lib/config";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandMark } from "./shell";

export function SignIn() {
  const { signIn } = useSession();
  const [token, setToken] = useState(isLocalNode() || MOCK_MODE ? LOCAL_DEFAULT_TOKEN : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await checkToken(token.trim());
      await signIn(token.trim());
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.code === "UNAUTHORIZED" || err.status === 401
            ? "The node rejected this token. Use the ADMIN_TOKEN the node was started with."
            : err.message
          : "Could not connect to the clearing node.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-[25rem]">
        <div className="mb-8 flex items-center gap-3">
          <BrandMark className="size-10" />
          <div>
            <h1 className="text-lg leading-tight font-semibold tracking-[-0.01em]">Payminto Clearing</h1>
            <p className="text-sm text-muted-foreground">Agent payments, cleared on HashKey Chain</p>
          </div>
        </div>
        <form onSubmit={onSubmit} className="rounded-xl border bg-card p-6" noValidate>
          <h2 className="font-semibold">Connect to your clearing node</h2>
          <p className="mt-1 text-sm text-muted-foreground">The admin token stays in this browser and is sent only to the node below.</p>
          <div className="mt-5 space-y-1.5">
            <p className="text-sm text-muted-foreground">Node</p>
            <p className="hash rounded-md bg-muted px-3 py-2 text-sm break-all">{MOCK_MODE ? "mock (in-browser fixtures)" : NODE_URL}</p>
          </div>
          <div className="mt-4 space-y-1.5">
            <Label htmlFor="token">Admin token</Label>
            <Input
              id="token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "token-error" : "token-hint"}
              className="hash"
            />
            {error ? (
              <p id="token-error" role="alert" className="text-sm text-negative">
                {error}
              </p>
            ) : (
              <p id="token-hint" className="text-xs text-muted-foreground">
                The ADMIN_TOKEN the node was started with.{isLocalNode() ? " Local nodes default to dev-admin-token." : ""}
              </p>
            )}
          </div>
          <Button type="submit" className="mt-5 w-full" disabled={busy || !token.trim()}>
            {busy && <Loader2 className="animate-spin" />}
            {busy ? "Connecting" : "Connect"}
          </Button>
        </form>
      </div>
    </main>
  );
}
