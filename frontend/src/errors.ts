// What to show a person when something threw.
//
// `catch` gives you `unknown`, and every screen that talks to the server had
// grown its own `caught.message ?? 'something went wrong'`. They differed only
// in the fallback wording, which is the one part worth stating per call.

/** The message to show for a thrown value, whatever kind of value it was. */
export const failureMessage = (caught: unknown, fallback = 'Something went wrong.') =>
  caught instanceof Error && caught.message ? caught.message : fallback;
