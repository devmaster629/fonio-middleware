# Client reply — Back Office role + email clarification

Copy/paste (or adapt) for Freelancer:

---

Thank you for the update — and yes, please go ahead and release the final milestone. Your team’s testing over the next days is very helpful.

**1) Back Office role (new)**

We are adding a dedicated **Back Office** role for employees who need to:

- assign / confirm / skip payments  
- view reservations (including guest details)  
- open guest conversations  

…but **without** access to technical settings such as webhooks, integrations, user management, sync/log configuration, or fonio setup.

Permissions are configured with **simple checkboxes per role**, so you can fine-tune exactly which pages and features each role may use. Super Admin keeps full control.

This is implemented in the codebase first; we will roll it out after your current employee review window so testing stays undisturbed.

**2) Emails — what to expect**

There are **two different email paths** (easy to mix up):

| Address | Purpose | When you get mail |
|--------|---------|-------------------|
| `technik@brainions.de` | Hostaway **webhook failure** alerts only | Only if Hostaway cannot deliver a webhook to our server after retries. If everything is healthy, **you will see no email** — that is expected. |
| `vermietung@brainions.de` | **Payment applied** notifications from our middleware | Only after a payment is **auto-applied** or **Confirm & apply** in Admin → Payments. Pending items in the review queue do **not** send email. |

What we tested earlier:

- SMTP credentials were accepted by `send.one.com` and a test message was submitted **to `vermietung@brainions.de`** (not to `technik@`).  
- We did **not** trigger a real Hostaway webhook failure, so `technik@` should stay empty.  
- We also did **not** apply a live review-queue payment during your employee testing, to avoid changing Hostaway bookings unexpectedly.

Please check **spam / quarantine** for `vermietung@brainions.de` for a subject like `[Hostaway Payments] SMTP test`.  
If it is missing, tell us and after your review days we can send a controlled test again (or you confirm one payment in the review queue — that will send a real payment alert).

**3) Next**

Please continue testing with your employees. Once you are ready, send the next feature idea and we will continue development.

---
