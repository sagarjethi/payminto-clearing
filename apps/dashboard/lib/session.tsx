"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createApi, type ClearingApi } from "./api";
import { MOCK_MODE, readToken, writeToken } from "./config";

type SessionState =
  | { status: "loading"; api: null }
  | { status: "signed-out"; api: null }
  | { status: "signed-in"; api: ClearingApi };

type SessionContextValue = SessionState & {
  signIn: (token: string) => Promise<void>;
  signOut: () => void;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading", api: null });
  const qc = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    const token = readToken() ?? (MOCK_MODE ? "mock" : null);
    if (!token) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the token lives in localStorage, readable only after hydration
      setState({ status: "signed-out", api: null });
      return;
    }
    void createApi(token).then((api) => {
      if (!cancelled) setState({ status: "signed-in", api });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (token: string) => {
    const api = await createApi(token);
    writeToken(token);
    qc.clear();
    setState({ status: "signed-in", api });
  }, [qc]);

  const signOut = useCallback(() => {
    writeToken(null);
    qc.clear();
    setState({ status: "signed-out", api: null });
  }, [qc]);

  const value = useMemo(() => ({ ...state, signIn, signOut }), [state, signIn, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}

/** The signed-in API client. Only call from screens rendered inside the console shell. */
export function useApi(): ClearingApi {
  const s = useSession();
  if (s.status !== "signed-in") throw new Error("useApi called without a session");
  return s.api;
}
