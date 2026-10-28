import { afterAll, describe, expect, it } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "../src/db/database.ts";
import { DISPOSABLE_FLAG, assertDisposableTarget, isDisposableTarget } from "../src/db/guard.ts";
import { accounts, Ledger, UnbalancedJournalError } from "../src/ledger.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { ANVIL_KEYS, tempDir } from "./helpers.ts";

const tmp = tempDir("payminto-storage-");
afterAll(() => tmp.cleanup());

const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const PROVIDER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

describe("database", () => {
  it("migrates once, in WAL mode with foreign keys on", () => {
    const db = new Database(join(tmp.dir, "a.test.db"));
    expect(db.migrate()).toBe(2);
    expect(db.migrate()).toBe(0);
    expect(db.get<{ journal_mode: string }>("PRAGMA journal_mode")!.journal_mode).toBe("wal");
    expect(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")!.foreign_keys).toBe(1);
    db.close();
  });

  it("sums decimal-text amounts beyond int64 exactly", () => {
    const db = new Database(":memory:");
    db.raw.exec("CREATE TABLE t (v TEXT)");
    for (const v of ["9223372036854775807", "9223372036854775807", "1"]) db.run("INSERT INTO t VALUES (?)", v);
    expect(db.get<{ s: string }>("SELECT bigsum(v) AS s FROM t")!.s).toBe("18446744073709551615");
    db.close();
  });

  it("rolls back a failed transaction and publishes after-commit hooks only on commit", () => {
    const db = new Database(":memory:");
    db.raw.exec("CREATE TABLE t (v INTEGER)");
    const fired: string[] = [];
    expect(() =>
      db.tx(() => {
        db.run("INSERT INTO t VALUES (1)");
        db.afterCommit(() => fired.push("rolled-back"));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    db.tx(() => {
      db.run("INSERT INTO t VALUES (2)");
      db.tx(() => db.run("INSERT INTO t VALUES (3)")); // nested joins the outer transaction
      db.afterCommit(() => fired.push("committed"));
    });
    expect(db.all<{ v: number }>("SELECT v FROM t ORDER BY v").map((r) => r.v)).toEqual([2, 3]);
    expect(fired).toEqual(["committed"]);
    expect(() => db.tx(() => Promise.resolve(1) as unknown as number)).toThrow(/synchronous/);
    db.close();
  });
});

describe("ledger", () => {
  const db = new Database(join(tmp.dir, "ledger.test.db"));
  db.migrate();
  const ledger = new Ledger(db);

  it("posts balanced journals and the trial balance stays at zero", () => {
    ledger.post("call.accepted", "c1", "call", [
      { account: accounts.providerReceivable(PROVIDER), debit: 2_000n },
      { account: accounts.agentPayable(AGENT), credit: 2_000n },
    ]);
    ledger.post("call.accepted", "c2", "call", [
      { account: accounts.providerReceivable(PROVIDER), debit: 3_000n },
      { account: accounts.agentPayable(AGENT), credit: 3_000n },
    ]);
    ledger.post("batch.settled", "b1", "batch", [
      { account: accounts.agentPayable(AGENT), debit: 5_000n },
      { account: accounts.providerReceivable(PROVIDER), credit: 5_000n },
      { account: accounts.providerWallet(PROVIDER), debit: 5_000n },
      { account: accounts.agentWallet(AGENT), credit: 5_000n },
    ]);
    const tb = ledger.trialBalance();
    expect(tb).toMatchObject({ balanced: true, balance: "0", totalDebit: "15000", totalCredit: "15000", journals: 3 });
    const byAccount = Object.fromEntries(tb.accounts.map((a) => [a.account, a.balance]));
    expect(byAccount[accounts.agentPayable(AGENT)]).toBe("0");
    expect(byAccount[accounts.providerReceivable(PROVIDER)]).toBe("0");
    expect(byAccount[accounts.providerWallet(PROVIDER)]).toBe("5000");
    expect(byAccount[accounts.agentWallet(AGENT)]).toBe("-5000");
  });

  it("refuses unbalanced, one-sided, negative or single-line journals and writes nothing", () => {
    const before = ledger.trialBalance().journals;
    expect(() =>
      ledger.post("call.accepted", "x", "bad", [
        { account: "a", debit: 1n },
        { account: "b", credit: 2n },
      ]),
    ).toThrow(UnbalancedJournalError);
    expect(() => ledger.post("call.accepted", "x", "bad", [{ account: "a", debit: 1n, credit: 1n }, { account: "b" }])).toThrow(UnbalancedJournalError);
    expect(() => ledger.post("call.accepted", "x", "bad", [{ account: "a", debit: -1n }, { account: "b", credit: -1n }])).toThrow(UnbalancedJournalError);
    expect(() => ledger.post("call.accepted", "x", "bad", [{ account: "a", debit: 0n }])).toThrow(UnbalancedJournalError);
    expect(ledger.trialBalance().journals).toBe(before);
  });

  it("filters entries by account or party prefix", () => {
    expect(ledger.entries({ account: accounts.agentPayable(AGENT), limit: 10 })).toHaveLength(3);
    expect(ledger.entries({ account: `agent:${AGENT}`, limit: 10 })).toHaveLength(4);
    const page = ledger.entries({ limit: 2 });
    expect(ledger.entries({ limit: 10, cursor: page[1]!.id })[0]!.id).toBeLessThan(page[1]!.id);
  });
});

describe("data-safety guard", () => {
  it("accepts only disposable targets", () => {
    expect(isDisposableTarget(join(tmp.dir, "x.db")).ok).toBe(true); // temp dir
    expect(isDisposableTarget("/srv/payminto/clearing.test.db").ok).toBe(true);
    expect(isDisposableTarget("/srv/payminto/clearing.demo.db").ok).toBe(true);
    expect(isDisposableTarget(":memory:").ok).toBe(true);
    // Absolute on purpose: a relative path is disposable when the checkout itself lives in the temp dir (CI, scratch clones).
    expect(isDisposableTarget("/var/lib/payminto/data/clearing.db").ok).toBe(false);
    expect(isDisposableTarget("/srv/payminto/clearing.db").ok).toBe(false);
    expect(isDisposableTarget("/srv/payminto/test.db.backup").ok).toBe(false);
    expect(isDisposableTarget("/srv/payminto/clearing.db", [DISPOSABLE_FLAG]).ok).toBe(true);
    expect(() => assertDisposableTarget("/var/lib/payminto/data/clearing.db")).toThrow(/Refusing/);
  });
});

describe("config", () => {
  const base = { OPERATOR_KEY: ANVIL_KEYS[9], ADMIN_TOKEN: "dev-admin-token", CHAIN_ID: "31337" };

  it("reads hub and token from the deployments file", () => {
    const dir = join(tmp.dir, "deployments");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "31337.json"),
      JSON.stringify({ clearingHub: "0x5fbdb2315678afecb367f032d93f642f64180aa3", token: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512", chainId: 31337, blockNumber: 2 }),
    );
    const c = loadConfig({ ...base, DEPLOYMENTS_DIR: dir });
    expect(c.hub).toBe("0x5FbDB2315678afecb367f032d93F642f64180aa3");
    expect(c.token).toBe("0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512");
    expect(c.hsp.verifyingContract).toBe(c.hub);
    expect(c.deployBlock).toBe(2n);
    expect(c.port).toBe(8787);
    expect(c.rpcUrl).toBe("http://127.0.0.1:8545");
  });

  it("names every problem without echoing secret values", () => {
    try {
      loadConfig({ OPERATOR_KEY: "0xnot-a-key-super-secret", ADMIN_TOKEN: "short", CHAIN_ID: "5", PORT: "abc" });
      throw new Error("expected ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/OPERATOR_KEY/);
      expect(msg).toMatch(/ADMIN_TOKEN/);
      expect(msg).toMatch(/CHAIN_ID/);
      expect(msg).toMatch(/PORT/);
      expect(msg).not.toMatch(/super-secret/);
    }
  });

  it("requires coordinator settings in coordinator mode", () => {
    expect(() =>
      loadConfig({ ...base, DEPLOYMENTS_DIR: join(tmp.dir, "deployments"), HSP_MODE: "coordinator" }),
    ).toThrow(/HSP_COORDINATOR_URL[\s\S]*HSP_API_KEY[\s\S]*HSP_CHAIN_NAME[\s\S]*HSP_VERIFYING_CONTRACT/);
  });
});
