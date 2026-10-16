import {
  GetAirportRoutesResponse,
  GetAirportsResponse,
  GetFlightSummaryResponse,
  GetFlightsResponse,
} from "@workspace/api-zod";
import { Router, type IRouter } from "express";
import {
  getFlightsSnapshot,
  getSouthAfricanAirports,
  getSouthAfricanAirportRoutes,
  summarizeFlights,
} from "../lib/aviation-data";

const router: IRouter = Router();

router.get("/flights", async (req, res): Promise<void> => {
  try {
    const snapshot = await getFlightsSnapshot();
    res.json(GetFlightsResponse.parse(snapshot));
  } catch (error) {
    req.log.error({ err: error }, "Unable to load current flight data");
    res.status(503).json({
      error: "Live flight data is temporarily unavailable. Please try again.",
    });
  }
});

router.get("/flights/summary", async (req, res): Promise<void> => {
  try {
    const summary = summarizeFlights(await getFlightsSnapshot());
    res.json(GetFlightSummaryResponse.parse(summary));
  } catch (error) {
    req.log.error({ err: error }, "Unable to load flight summary");
    res.status(503).json({
      error: "Flight summary is temporarily unavailable. Please try again.",
    });
  }
});

router.get("/airports", async (req, res): Promise<void> => {
  try {
    const airports = await getSouthAfricanAirports();
    res.json(GetAirportsResponse.parse(airports));
  } catch (error) {
    req.log.error({ err: error }, "Unable to load South African airports");
    res.status(503).json({
      error: "Airport reference data is temporarily unavailable. Please try again.",
    });
  }
});

router.get("/airport-routes", async (req, res): Promise<void> => {
  try {
    const routes = await getSouthAfricanAirportRoutes();
    res.json(GetAirportRoutesResponse.parse(routes));
  } catch (error) {
    req.log.error({ err: error }, "Unable to load airport route references");
    res.status(503).json({
      error: "Airport route data is temporarily unavailable. Please try again.",
    });
  }
});

export default router;
