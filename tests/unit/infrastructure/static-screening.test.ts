import { describe, expect, it } from "vitest";

import { screeningStatusForVerdict } from "../../../src/domain/compliance/screening-provider.js";
import { StaticSanctionsListProvider } from "../../../src/infrastructure/compliance/static-list-provider.js";

const sanctionedAddress = "0xD78523784b3A8e5c21D026eE7Fe405C39D1542ac";
const cleanAddress = "0xC46E38c24c706e0cea851317CD8CF05a0Bd7BD05";

describe("StaticSanctionsListProvider", () => {
  const provider = new StaticSanctionsListProvider({
    listVersion: "unit-v1",
    addresses: [sanctionedAddress],
  });

  it("blocks listed addresses regardless of case", async () => {
    for (const address of [
      sanctionedAddress,
      sanctionedAddress.toLowerCase(),
      sanctionedAddress.toUpperCase().replace("0X", "0x"),
    ]) {
      const screening = await provider.screen({ address, chain: "ethereum-sepolia" });
      expect(screening.verdict).toBe("blocked");
      expect(screening.riskLevel).toBe("blocked");
      expect(screening.sanctioned).toBe(true);
      expect(screening.listVersion).toBe("unit-v1");
    }
  });

  it("clears addresses that are not listed", async () => {
    const screening = await provider.screen({
      address: cleanAddress,
      chain: "ethereum-sepolia",
    });
    expect(screening.verdict).toBe("clear");
    expect(screening.riskLevel).toBe("clear");
    expect(screening.sanctioned).toBe(false);
  });

  it("returns indeterminate for malformed addresses instead of approving", async () => {
    const screening = await provider.screen({
      address: "not-an-address",
      chain: "ethereum-sepolia",
    });
    expect(screening.verdict).toBe("indeterminate");
    expect(screening.riskLevel).toBe("unknown");
    expect(screening.sanctioned).toBe(false);
  });

  it("treats an empty operator list as clear with provenance", async () => {
    const empty = new StaticSanctionsListProvider({
      listVersion: "empty-v1",
      addresses: [],
    });
    const screening = await empty.screen({
      address: cleanAddress,
      chain: "ethereum-sepolia",
    });
    expect(screening.verdict).toBe("clear");
    expect(screening.provider).toBe("static-list");
    expect(screening.listVersion).toBe("empty-v1");
  });
});

describe("screeningStatusForVerdict", () => {
  it("maps verdicts to fail-closed payment screening states", () => {
    expect(screeningStatusForVerdict("clear")).toBe("clear");
    expect(screeningStatusForVerdict("flagged")).toBe("flagged");
    expect(screeningStatusForVerdict("blocked")).toBe("blocked");
    expect(screeningStatusForVerdict("unavailable")).toBe("pending");
    expect(screeningStatusForVerdict("indeterminate")).toBe("pending");
  });
});
