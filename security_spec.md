# Yunerth Memory Core Security Specification

## 1. Data Invariants
1. Default-deny catch-all closes all paths unless explicitly permitted.
2. User root documents `/users/{userId}` can only be read or created/updated by the exact verified owner (`request.auth.uid == userId && request.auth.token.email_verified == true`), contain zero PII (no email/phone/address), and cannot be listed or deleted.
3. Every memory document `/users/{userId}/memories/{memoryId}` requires an existing parent `/users/{userId}` document whose `uid` equals `userId` (`Master Gate`).
4. `ownerId` and `id` must match path parameters `{userId}` and `{memoryId}`, match `^[a-zA-Z0-9_-]+$`, and remain immutable after creation.
5. `createdAt` equals `request.time` on creation and remains immutable on update; `updatedAt` equals `request.time` on both create and update.
6. `description` must be a string between 3 and 600 characters; `category` must be one of the 7 text-only Memory Core categories (no image category).
7. `list` queries on memories explicitly enforce `request.auth.uid == userId && resource.data.ownerId == request.auth.uid` without `get()` calls inside list rules.

## 2. Adversarial "Dirty Dozen" Payloads (Expected: PERMISSION_DENIED)
1. **Cross-User Read (`get`)**: User B attempts `get(/users/userA/memories/mem1)` -> Denied (`isOwner` fails).
2. **Cross-User List (`list`)**: User B attempts `list(/users/userA/memories)` -> Denied (`ownerId == request.auth.uid` fails).
3. **Directory Scraping (`list /users`)**: Any signed-in user attempts `list(/users)` -> Denied (`allow list: if false`).
4. **Owner Spoofing (`create`)**: User B writes to `/users/userB/memories/mem1` with `ownerId: "userA"` -> Denied (`data.ownerId == userId`).
5. **Shadow Ghost Field (`create`)**: Owner writes memory with extra `{ isAdmin: true }` -> Denied (`hasOnly` fails).
6. **Shadow Update (`update`)**: Owner updates memory attempting to mutate `ownerId` or `createdAt` -> Denied (`affectedKeys().hasOnly(...)` & immutability fails).
7. **Unverified Email Write**: User with `email_verified: false` attempts `create` or `update` -> Denied (`isVerifiedOwner` fails).
8. **Orphaned Subcollection Write**: Signed-in user attempts to create `/users/userA/memories/mem1` before `/users/userA` exists -> Denied (`exists(/users/userA)` Master Gate fails).
9. **Disallowed Image Category**: Owner attempts to save memory with `category: "Images"` -> Denied (`category in [...]` fails).
10. **Oversized Description / Denial of Wallet**: Owner attempts `description` of 10,000 characters -> Denied (`size() <= 600` fails).
11. **Path ID Poisoning**: Request uses malformed ID `bad/id!#` or >128 chars -> Denied (`isValidId` fails).
12. **Client Timestamp Forgery**: Payload sends hardcoded past/future `createdAt` instead of `request.time` -> Denied (`incoming().createdAt == request.time` fails).
