import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { MAX_DURATION_MIN, MIN_DURATION_MIN } from "../../normalize/schemas.js";
import { ApiError } from "../errors.js";
import { type BookingsReader, type BookingsWriter, bookingViewSchema } from "../repos/types.js";

export const READ_SOURCES = ["firestore", "postgres", "shadow"] as const;
export type ReadSource = (typeof READ_SOURCES)[number];

export type BookingRoutesDeps = {
  /** From BOOKINGS_READ_SOURCE: flipping it moves these screens between stores. */
  readSource: ReadSource;
  /** Lets the x-read-source header pick a store per request. Never in production. */
  allowHeaderOverride: boolean;
  readers: Partial<Record<ReadSource, BookingsReader>>;
  writer: BookingsWriter;
};

const legacyIdParams = z.object({ legacyId: z.string().min(1).max(200) });
const windowQuery = z
  .object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })
  .refine((q) => Date.parse(q.from) < Date.parse(q.to), "`to` must be after `from`");
const createBody = z.strictObject({
  studentId: z.string().min(1),
  instructorId: z.string().min(1),
  pickupPointId: z.string().min(1).nullable().default(null),
  startsAt: z.iso.datetime({ offset: true }),
  durationMin: z.number().int().min(MIN_DURATION_MIN).max(MAX_DURATION_MIN),
  status: z.enum(["booked", "confirmed"]).default("booked"),
  priceCents: z.number().int().min(0).nullable().default(null),
  notes: z.string().max(2000).nullable().default(null),
});

export async function bookingRoutes(app: FastifyInstance, deps: BookingRoutesDeps): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    "/v1/bookings/:legacyId",
    { schema: { params: legacyIdParams, response: { 200: bookingViewSchema } } },
    async (request, reply) => {
      const { source, reader } = readerFor(request, deps);
      const booking = await reader.getByLegacyId(request.params.legacyId);
      if (!booking) throw new ApiError(404, "NOT_FOUND", "No booking with that id.");
      reply.header("x-read-source", source);
      return booking;
    },
  );

  routes.get(
    "/v1/instructors/:legacyId/bookings",
    {
      schema: {
        params: legacyIdParams,
        querystring: windowQuery,
        response: { 200: z.object({ bookings: z.array(bookingViewSchema) }) },
      },
    },
    async (request, reply) => {
      const { source, reader } = readerFor(request, deps);
      const { from, to } = request.query;
      const bookings = await reader.listForInstructor(
        request.params.legacyId,
        new Date(from),
        new Date(to),
      );
      if (!bookings) throw new ApiError(404, "NOT_FOUND", "No instructor with that id.");
      reply.header("x-read-source", source);
      return { bookings };
    },
  );

  // Writes go to Postgres, the future source of truth, whatever the read source.
  routes.post(
    "/v1/bookings",
    { schema: { body: createBody, response: { 201: bookingViewSchema } } },
    async (request, reply) => {
      const body = request.body;
      const created = await deps.writer.create({ ...body, startsAt: new Date(body.startsAt) });
      reply.code(201).header("location", `/v1/bookings/${created.id}`);
      return created;
    },
  );
}

function readerFor(
  request: FastifyRequest,
  deps: BookingRoutesDeps,
): { source: ReadSource; reader: BookingsReader } {
  const header = request.headers["x-read-source"];
  const requested = deps.allowHeaderOverride
    ? z.enum(READ_SOURCES).safeParse(header).data
    : undefined;
  const source = requested ?? deps.readSource;
  const reader = deps.readers[source];
  if (!reader)
    throw new ApiError(503, "SOURCE_UNAVAILABLE", `The ${source} read path isn't configured.`);
  return { source, reader };
}
