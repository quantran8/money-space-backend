# Household invites

How a second person joins a household (spec §6). Related:
[[members-and-lifecycle-safeguard]], [[households-and-onboarding]], [[auth]].

## The constraint everything follows from

At accept time the invitee is **someone with a token and nothing else** — not a
member, with no household to be scoped to. Every design decision here is a
consequence:

- the token is looked up **alone**, with no household id;
- the pre-accept preview reveals **no money**;
- the accept route lives on a controller with **no `:householdId` param**.

## The routing detail that will bite

`HouseholdAccessGuard` returns early only when `params.householdId` is absent.
The moment a household id appears in the path, the guard requires the caller to
already be a live member of that household.

So `/households/:hid/invites/:token/accept` would **403 every invitee** for not
being a member — precisely the state they are trying to leave. The accept route
therefore lives at `/api/invites/:token/accept` on `InviteTokensController`,
which takes no household param at all.

**The route shape IS the authorization design, not a stylistic choice.** Moving
these routes under a household scope silently breaks joining.

Authentication is still required (these routes are NOT `@Public`): joining
attaches a real identity to a real member row, so we must know who is joining.
Prior *membership* is what cannot be required.

## Two controllers

| Controller | Path | Who | Gate |
|---|---|---|---|
| `InvitesController` | `/households/:hid/invites` | the inviter | `admin` |
| `InviteTokensController` | `/invites/:token` | the invitee | authenticated only |

Admin, not edit: handing someone access to the household's money is a membership
decision, not content editing.

## The token

`randomUUID()` — crypto-strong, 122 bits. Deliberately **not** `uuidv7` like our
row ids: v7 embeds a timestamp, so a token minted from it would leak when it was
created and be partially guessable from a known sibling.

## The preview

Returns exactly: household name, inviter name, status, expiry,
`acceptable`. **Nothing financial** — a token holder has been granted nothing
yet, and the link may have been forwarded to anyone.

`status` reports `expired` even while the row still reads `pending`: expiry is
only applied lazily, so **the timestamp is the truth, not the column**.

An unknown token and a token for a deleted household both 404 with the same
message. Distinguishing them would let anyone probe which tokens ever existed.

## Accepting

One transaction (`acceptInvite`), because a half-applied accept leaves a consumed
token with no membership — locking the invitee out permanently:

1. **upsert the profile** — the invitee may be signing in for the very first time;
2. **re-check membership INSIDE the transaction** — two taps on the same link
   race, and `household_members_unique` would raise a constraint error instead of
   the friendly no-op the caller expects. Already a member → still consume the
   token (the invite did its job) and return `alreadyMember: true`;
3. **insert the member.** No role and no permission: whoever accepts an invite
   is an equal member of the household;
4. **consume the invite**, guarded on `status = 'pending'` so a concurrent accept
   can only win once;
5. **audit** `household.member_joined`.

Refused when the invite is `accepted`, `cancelled`, or past `expiresAt`.

## Statuses

`pending | accepted | expired | cancelled` — matching the DB enum exactly.
`cancelled` is withdrawal by the inviter. An **accepted** invite cannot be
revoked: the person did join, and rewriting that would misrepresent history.

Default expiry 14 days, max 90.

## Where it lives in code

- **backend**: `src/modules/invites/`. Note `HouseholdsService.createHousehold`
  also mints an invite inline when `inviteEmail` is supplied during onboarding —
  same table, same accept flow.
- **frontend-web**: pending (`/invite/:token` landing page).
