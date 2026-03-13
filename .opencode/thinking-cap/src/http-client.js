import http from "node:http"
import { DEFAULT_PORT } from "./constants.js"

function request(method, path, body, port = DEFAULT_PORT) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "content-type": "application/json",
        },
      },
      (res) => {
        let data = ""
        res.on("data", (chunk) => {
          data += chunk
        })
        res.on("end", () => {
          try {
            resolve(data ? JSON.parse(data) : {})
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    req.on("error", reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

export function getState(port) {
  return request("GET", "/state", null, port)
}

export function sendEvent(payload, port) {
  return request("POST", "/events", payload, port)
}

export function sendReview(action, port) {
  return request("POST", "/review", { action }, port)
}
