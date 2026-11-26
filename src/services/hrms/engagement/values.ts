// The standard recognition values, seeded on first bootstrap. Keys and wording match the dashboard's seed
// (lib/hrms/people/seedEngagement.ts VALUES) so kudos keep referencing a value by its stable key ("v_customer").

export interface StandardValue { key: string; name: string; blurb: string }

export const STANDARD_VALUES: StandardValue[] = [
  { key: 'v_customer', name: 'Customer first', blurb: 'We start from what the customer needs.' },
  { key: 'v_owner', name: 'Own it', blurb: 'We follow a problem through to the end.' },
  { key: 'v_safe', name: 'Safety always', blurb: 'Nothing is urgent enough to be unsafe.' },
  { key: 'v_simple', name: 'Keep it simple', blurb: 'We cut steps that do not help anyone.' },
  { key: 'v_help', name: 'Help each other', blurb: 'We share what we know and cover for each other.' },
];
