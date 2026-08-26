/**
 * The shape the options reference reads. Each mode's control panel describes
 * itself in these terms, from the same definitions it renders — so the reference
 * lists what the panel actually offers, and the dot-paths it publishes are the
 * ones deep links accept.
 */
export interface OptionDoc {
  group: string;
  label: string;
  /** Dot-path into the config — the key a deep link uses. Null if not derivable. */
  path: string | null;
  kind: 'range' | 'choice';
  range?: { min: number; max: number; step: number };
  choices?: string[];
  /** The default, formatted the way the panel shows it. */
  value: string;
  info?: { what: string; how: string; expect: string };
}

/** A mode's options, as the reference page groups them. */
export interface OptionSection {
  id: string;
  title: string;
  blurb: string;
  options: OptionDoc[];
}
