import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  asterUserAddress,
  asterV3Path,
  formEncode,
  isAsterV3,
  normalizeAsterPk,
  signAsterV3,
} from "./aster-sign.ts";

const DOMAIN = {
  name: "AsterSignTransaction",
  version: "1",
  chainId: 1666,
  verifyingContract: "0x0000000000000000000000000000000000000000" as const,
} as const;

const TYPES = {
  Message: [{ name: "msg", type: "string" }],
} as const;

describe("aster v3 wallet auth", () => {
  it("rewrites v1/v2 signed paths onto v3", () => {
    assert.equal(asterV3Path("/fapi/v1/order"), "/fapi/v3/order");
    assert.equal(asterV3Path("/fapi/v2/account"), "/fapi/v3/account");
    assert.equal(asterV3Path("/fapi/v2/positionRisk"), "/fapi/v3/positionRisk");
    assert.equal(asterV3Path("/fapi/v3/balance"), "/fapi/v3/balance");
  });

  it("builds an ASCII-sorted form body without dropping 0x", () => {
    const msg = formEncode({
      symbol: "BTCUSDT",
      nonce: "1748310859508867",
      user: "0x63DD5aCC6b1aa0f563956C0e534DD30B6dcF7C4e",
      signer: "0x21cF8Ae13Bb72632562c6Fff438652Ba1a151bb0",
    });
    assert.equal(
      msg,
      "nonce=1748310859508867&signer=0x21cF8Ae13Bb72632562c6Fff438652Ba1a151bb0&symbol=BTCUSDT&user=0x63DD5aCC6b1aa0f563956C0e534DD30B6dcF7C4e",
    );
  });

  it("detects API-wallet credentials and ignores leftover hmac strings", () => {
    const pk = generatePrivateKey();
    assert.equal(
      isAsterV3({
        venue: "aster",
        walletAddress: "0x63dd5acc6b1aa0f563956c0e534dd30b6dcf7c4e",
        privateKey: pk,
      }),
      true,
    );
    assert.equal(isAsterV3({ venue: "aster", apiSecret: pk }), true);
    assert.equal(
      asterUserAddress({ venue: "aster", apiKey: "0x63dd5acc6b1aa0f563956c0e534dd30b6dcf7c4e" }),
      "0x63DD5aCC6b1aa0f563956C0e534DD30B6dcF7C4e",
    );
    assert.equal(normalizeAsterPk(pk.slice(2)), pk);
    assert.equal(
      isAsterV3({ venue: "aster", apiKey: "legacy-hmac-key", apiSecret: "legacy-hmac-secret" }),
      false,
    );
  });

  it("EIP-712 signature recovers to the API wallet (signer)", async () => {
    const pk = generatePrivateKey();
    const signer = privateKeyToAccount(pk);
    const msg =
      "nonce=1748310859508867&signer=" +
      signer.address +
      "&symbol=BTCUSDT&user=0x63DD5aCC6b1aa0f563956C0e534DD30B6dcF7C4e";
    const signature = await signAsterV3(pk, msg);
    assert.match(signature, /^0x[0-9a-fA-F]{130}$/);
    const recovered = await recoverTypedDataAddress({
      domain: DOMAIN,
      types: TYPES,
      primaryType: "Message",
      message: { msg },
      signature,
    });
    assert.equal(recovered.toLowerCase(), signer.address.toLowerCase());
  });
});
