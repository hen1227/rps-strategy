// The tools, in the words of what they do.
//
// The person watching did not ask for `lab_set_starting_position`; they asked
// for a game. So the timeline leads with "Drew the opening board" and keeps the
// tool's real name beside it in small type — visible, because a page whose whole
// claim is that it hands an agent real tools should show them, and secondary,
// because it is not what anybody is reading for.
//
// A tool with no entry here still renders: the name is de-prefixed and used as
// written, which is worse but never wrong, and it means adding a tool does not
// mean remembering to add it twice.

export interface ToolLabel {
  label: string;
}

export const TOOL_LABELS: Record<string, ToolLabel> = {
  lab_get_state: { label: 'Looked at the workbench' },
  lab_describe_language: { label: 'Read the rule format' },
  lab_validate: { label: 'Checked the rules' },
  lab_patch_spec: { label: 'Edited the rules' },
  lab_set_spec: { label: 'Rewrote the rules' },
  lab_set_starting_position: { label: 'Drew the opening board' },
  lab_new_test_game: { label: 'Started a test game' },
  lab_simulate: { label: 'Played it against itself' },
  lab_get_position: { label: 'Looked at the board' },
  lab_legal_moves: { label: 'Listed the legal moves' },
  lab_play_move: { label: 'Played a move' },
  lab_undo: { label: 'Took a move back' },
  lab_end_test_game: { label: 'Ended the test game' },
  lab_add_image: { label: 'Added a picture' },
  lab_list_images: { label: 'Looked at the pictures' },
  lab_search_parts: { label: 'Searched for reusable parts' },
  lab_get_part: { label: 'Read a reusable part' },
  lab_save_draft: { label: 'Saved a draft' },
  lab_list_drafts: { label: 'Listed the drafts' },
  lab_load_draft: { label: 'Loaded a draft' },
  lab_recent_activity: { label: 'Caught up on what happened' },
  lab_ask_user: { label: 'Asked you something' },
  lab_propose_change: { label: 'Suggested a change' },
  lab_highlight: { label: 'Pointed at the board' },
  lab_publish_mode: { label: 'Asked to publish' },
  lab_publish_part: { label: 'Asked to publish a part' },
  // The person's own doing. Recorded the same way an agent's is, so the rail can
  // draw one history rather than two.
  fork: { label: 'Opened somebody else’s mode' },
  publish: { label: 'Published it' },
  edit_json: { label: 'Edited the rules by hand' },
  pick_art: { label: 'Chose a picture' },
};
