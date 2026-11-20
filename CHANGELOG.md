# Changelog

## 0.1.0

- First version: PopNow for Discord (`/popnow` with image, video, edit, animate, effect, remove-bg, upscale, balance, creations, login, logout) and Slack (`@PopNow` mentions and `/popnow`, answers in the thread).
- Connect with a PopNow account (OAuth 2.1, PKCE, dynamic registration). Tokens are kept encrypted. Logout revokes them.
- Every creation shows its price in credits on a button first, and nothing is charged until the person who asked presses it. A price change shows a new price. Consent needs the asker's own press.
- Files from Discord, and files attached to a Slack mention, go through an upload window. Results come back as attachments, or as links when they are too big.
