import { nanoid } from "nanoid";
import type { Kysely, Database, ApiKey } from "@hyperfleet/worker/database";
import type { Logger } from "@hyperfleet/logger";

/**
 * Service for managing API key authentication
 */
export class AuthService {
  constructor(
    private db: Kysely<Database>,
    private logger?: Logger
  ) {}

  /**
   * Hash an API key using Web Crypto API
   */
  private async hashKey(key: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(key);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return Buffer.from(hashBuffer).toString("hex");
  }

  /**
   * Create a new API key
   * Returns the raw key only once - it cannot be retrieved later
   */
  async createApiKey(
    name: string,
    scopes: string[] = ["*"]
  ): Promise<{ id: string; key: string; prefix: string }> {
    const id = nanoid(12);
    const rawKey = `hf_${nanoid(32)}`;
    const keyPrefix = rawKey.slice(0, 11);
    const keyHash = await this.hashKey(rawKey);

    await this.db
      .insertInto("api_keys")
      .values({
        id,
        name,
        key_hash: keyHash,
        key_prefix: keyPrefix,
        scopes: JSON.stringify(scopes),
      })
      .execute();

    this.logger?.info("API key created", { keyId: id, keyPrefix, name });
    return { id, key: rawKey, prefix: keyPrefix };
  }

  /**
   * Validate an API key and return the key record if valid
   */
  async validateKey(rawKey: string): Promise<ApiKey | null> {
    const keyHash = await this.hashKey(rawKey);

    const apiKey = await this.db
      .selectFrom("api_keys")
      .selectAll()
      .where("key_hash", "=", keyHash)
      .where("revoked_at", "is", null)
      .executeTakeFirst();

    if (!apiKey) {
      return null;
    }

    // Check expiration
    if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
      return null;
    }

    // Update last_used_at
    await this.db
      .updateTable("api_keys")
      .set({ last_used_at: new Date().toISOString() })
      .where("id", "=", apiKey.id)
      .execute();

    return apiKey;
  }

  /**
   * Check if a key has a required scope
   */
  hasScope(apiKey: ApiKey, requiredScope: string): boolean {
    const scopes: string[] = JSON.parse(apiKey.scopes);
    return scopes.includes("*") || scopes.includes(requiredScope);
  }

  /**
   * Revoke an API key
   */
  async revokeKey(id: string): Promise<boolean> {
    const result = await this.db
      .updateTable("api_keys")
      .set({ revoked_at: new Date().toISOString() })
      .where("id", "=", id)
      .where("revoked_at", "is", null)
      .executeTakeFirst();

    if ((result.numUpdatedRows ?? 0n) > 0n) {
      this.logger?.info("API key revoked", { keyId: id });
      return true;
    }
    return false;
  }

  /**
   * List all API keys (without the actual key hashes)
   */
  async listKeys(): Promise<
    Array<{
      id: string;
      name: string;
      key_prefix: string;
      scopes: string[];
      created_at: string;
      last_used_at: string | null;
      revoked_at: string | null;
    }>
  > {
    const keys = await this.db
      .selectFrom("api_keys")
      .select([
        "id",
        "name",
        "key_prefix",
        "scopes",
        "created_at",
        "last_used_at",
        "revoked_at",
      ])
      .orderBy("created_at", "desc")
      .execute();

    return keys.map((k) => ({
      ...k,
      scopes: JSON.parse(k.scopes),
    }));
  }
}
