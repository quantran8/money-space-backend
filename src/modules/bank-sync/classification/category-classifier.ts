export type ClassifyInput = {
  /** The money-event note, already stripped of bank boilerplate. */
  note: string;
  direction: 'IN' | 'OUT';
  providerCode: string | null;
};

/**
 * Picks a system category for a bank event from its note.
 *
 * Returns a system category `code`, or null to leave it to the default
 * (`income` / `other`). The seam for a later AI classifier: implement this and
 * rebind `CATEGORY_CLASSIFIER` in the module. Implementations must not throw.
 */
export interface CategoryClassifier {
  classify(input: ClassifyInput): Promise<string | null>;
}

export const CATEGORY_CLASSIFIER = Symbol('CATEGORY_CLASSIFIER');
