/**
 * When a lead arrives again (same phone/email), the merge fills in what the
 * existing lead is missing — e.g. a WhatsApp chat created it with only a phone,
 * and the bot later posts the email, company and demo notes. It never
 * overwrites values someone has already set.
 */
import { blankFieldPatch } from '../src/services/crm/integrations/dedup.orchestrator';

describe('blankFieldPatch (lead merge)', () => {
  it('fills blank fields and appends new notes', () => {
    const current = { first_name: 'Priya', last_name: 'Sharma', phone: '9811112222', email: null, company: '', notes: 'First WhatsApp message: hi' };
    expect(blankFieldPatch(current, { email: 'priya@acme.in', company: 'Acme Pharma', city: 'Pune', notes: 'Team size: 26–100 reps | Demo: 14 Oct 2026, 11:00 am IST' })).toEqual({
      email: 'priya@acme.in',
      company: 'Acme Pharma',
      city: 'Pune',
      notes: 'First WhatsApp message: hi\n\nTeam size: 26–100 reps | Demo: 14 Oct 2026, 11:00 am IST',
    });
  });

  it('never overwrites a value that is already set', () => {
    const current = { first_name: 'Priya', email: 'priya@old.in', company: 'Acme', city: 'Mumbai', notes: 'Called twice' };
    expect(blankFieldPatch(current, { first_name: 'P', email: 'priya@new.in', company: 'Other Co', city: 'Delhi', notes: 'Called twice' })).toEqual({});
  });

  it('replaces a placeholder name with a real one, but not the other way round', () => {
    expect(blankFieldPatch({ first_name: 'WhatsApp', last_name: 'lead' }, { first_name: 'Priya', last_name: 'Sharma' })).toEqual({ first_name: 'Priya', last_name: 'Sharma' });
    expect(blankFieldPatch({ first_name: 'Inquiry', last_name: null }, { first_name: 'Rahul', last_name: null })).toEqual({ first_name: 'Rahul', last_name: null });
    expect(blankFieldPatch({ first_name: 'Priya', last_name: 'Sharma' }, { first_name: 'WhatsApp', last_name: 'lead' })).toEqual({});
    expect(blankFieldPatch({ first_name: null, last_name: null }, { first_name: 'Inquiry' })).toEqual({});
  });

  it('caps appended notes', () => {
    const patch = blankFieldPatch({ notes: 'x'.repeat(3990) }, { notes: 'y'.repeat(100) });
    expect(patch.notes!.length).toBe(4000);
  });
});
