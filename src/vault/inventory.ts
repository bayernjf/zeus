import type { RealmStore } from '../realm/types.js';
import type { VaultInventory } from './types.js';

/** Adapt a connected Realm into the inventory port the map drawer consumes. */
export function inventoryFromRealm(store: RealmStore, realmId: string): VaultInventory {
  return {
    async describe() {
      const manifest = await store.manifest(realmId);
      return { realmId: manifest.realmId, type: manifest.type, root: manifest.root };
    },
    async entries() {
      return store.entries(realmId);
    },
  };
}
