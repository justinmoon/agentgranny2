import React, { useEffect, useState } from "react";
import type { MeState } from "../src/types.js";
import { readError } from "./http.js";

function Typewriter({ text, speed = 60 }: { text: string; speed?: number }) {
  const prefersReduced =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [count, setCount] = useState(prefersReduced ? text.length : 0);

  useEffect(() => {
    if (count >= text.length) return;
    const id = window.setTimeout(() => setCount((value) => value + 1), speed);
    return () => window.clearTimeout(id);
  }, [count, text, speed]);

  return (
    <span className="typewriter">
      {text.slice(0, count)}
      <span className="caret" aria-hidden="true" />
    </span>
  );
}

export function AuthScreen({
  onAuth,
  onAuthEnabled
}: {
  onAuth: (me: MeState) => void;
  onAuthEnabled: (enabled: boolean) => void;
}) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(mode === "login" ? "/api/auth/login" : "/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, fullName, password, inviteCode })
      });
      const payload = await response.json();
      onAuthEnabled(Boolean(payload.authEnabled));
      if (!response.ok) throw new Error(payload.error ?? JSON.stringify(payload));
      onAuth(payload as MeState);
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <div className="auth-stack">
        <p className="auth-tagline">
          <Typewriter text="Let's build with Agent Mom" />
        </p>
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
        {mode === "signup" && (
          <input value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="Full name" />
        )}
        <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email" type="email" />
        <input
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Password"
          type="password"
        />
        {mode === "signup" && (
          <input
            value={inviteCode}
            onChange={(event) => setInviteCode(event.target.value)}
            placeholder="Access code"
          />
        )}
        {error && <div className="form-error">{error}</div>}
        <button type="submit" disabled={busy || !email.trim() || !password}>
          {busy ? "Working" : mode === "login" ? "Log in" : "Sign up"}
        </button>
        <button
          type="button"
          className="auth-switch"
          onClick={() => {
            setMode(mode === "login" ? "signup" : "login");
            setError(undefined);
          }}
        >
          {mode === "login" ? "Need an account?" : "Have an account?"}
        </button>
        </form>
      </div>
    </main>
  );
}

export function LoadingScreen({ text, error, onRetry }: { text: string; error?: string; onRetry?: () => void }) {
  return (
    <main className="auth-shell">
      <div className="auth-form">
        <div className="brand auth-brand">
          <div className="brand-mark">AM</div>
          <div>
            <h1>Agent Mom</h1>
            <p>{text}</p>
          </div>
        </div>
        {error && <div className="form-error">{error}</div>}
        {onRetry && (
          <button type="button" className="auth-switch" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    </main>
  );
}
