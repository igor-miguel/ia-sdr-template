import { google } from "googleapis";
import { config } from "../config.js";

function getAuth() {
  return new google.auth.JWT({
    email: config.google.clientEmail,
    key: config.google.privateKey,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
}

export function getCalendarClient() {
  return google.calendar({ version: "v3", auth: getAuth() });
}

export const CALENDAR_ID = () => config.google.calendarId;
