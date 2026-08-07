# Client reply — CHECK24 timeline & scope

Copy/paste (or adapt):

---

Thanks for the feedback — your assumption is understandable, and you’re right that Hostaway already has most of the listing/calendar data.

The work isn’t mainly “pull 10–20 fields from Hostaway.” That’s the easy part. The time goes into building a reliable bridge to CHECK24:

1. **Mapping & structure** — CHECK24 expects its own listing model (rooms/units, amenities, photos, descriptions, cancellation rules, etc.). We have to map your Hostaway data into that format correctly, including your parent/apartment hierarchy where relevant.
2. **Ongoing sync** — not a one-time export: availability, prices, and restrictions need to stay in sync so you don’t get overbookings or wrong rates.
3. **Bookings back into Hostaway** — when a guest books on CHECK24, the reservation must land cleanly in your system (guest data, dates, status, channel).
4. **Edge cases & testing** — min stay, closed dates, updates/cancellations, API errors, retries, and a proper test run with CHECK24’s process.
5. **CHECK24 side** — partner onboarding / validation can add waiting time outside development; that isn’t “coding,” but it still affects go-live.

So **~1 week is a realistic first integration**, not because the API is mysteriously huge, but because a channel connection has to be correct and maintainable. Doing it in a day usually means a fragile one-off that breaks under real bookings.

If budget/ROI is the concern, we can also do it in stages:
- **Phase 1:** listings + availability/prices live on CHECK24  
- **Phase 2:** inbound bookings + polish  

That way you can judge traffic/value before paying for the full loop.

On the app: yes — I understand the overall structure and how Hostaway ↔ middleware ↔ fonio fit together. While you’re still integrating and adjusting features, I’m happy to handle the parts you can’t (or don’t want to) do via Claude, including paid follow-up work.

Happy to jump on a short call if you want to walk through scope vs. other portals and decide whether CHECK24 is worth it for you right now.

---
