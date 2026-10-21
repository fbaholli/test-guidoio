import { z } from "zod";
import { BOOKING_STATUSES } from "../../normalize/schemas.js";

// What the API returns, whichever store it read from. During the transition the app knows
// Firestore ids, so every reference is a legacy id (a merged student's surviving id).

export const bookingViewSchema = z.object({
  id: z.string(),
  studentId: z.string(),
  instructorId: z.string(),
  pickupPointId: z.string().nullable(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  status: z.enum(BOOKING_STATUSES),
  priceCents: z.number().int().nullable(),
  paid: z.boolean(),
  notes: z.string().nullable(),
  deleted: z.boolean(),
});

export type BookingView = z.infer<typeof bookingViewSchema>;

export type BookingsReader = {
  getByLegacyId(legacyId: string): Promise<BookingView | undefined>;
  /** Lessons overlapping [from, to), deleted ones left out; undefined if the instructor is unknown. */
  listForInstructor(
    instructorLegacyId: string,
    from: Date,
    to: Date,
  ): Promise<BookingView[] | undefined>;
};

export type CreateBookingInput = {
  studentId: string;
  instructorId: string;
  pickupPointId: string | null;
  startsAt: Date;
  durationMin: number;
  status: "booked" | "confirmed";
  priceCents: number | null;
  notes: string | null;
};

export type BookingsWriter = {
  create(input: CreateBookingInput): Promise<BookingView>;
};
