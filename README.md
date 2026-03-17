# Restart (Link: https://d2lau88lsg9qq2.cloudfront.net)
A website or App where you refresh your mind

# Restart — Deployment Guide

A step-by-step guide to deploying the secure AI Focus Mode backend on AWS
and hosting the frontend on Amazon S3.

---

## Architecture

```
Browser  (S3 static site)
   │
   │  POST /focus-mode  { "topic": "Data Structures" }
   ▼
AWS API Gateway  (HTTP API)
   │
   ▼
AWS Lambda  (backend/lambda/focusMode.js)
   │  reads GEMINI_API_KEY from environment variables
   ▼
Google Gemini API  (gemini-1.5-flash)
   │
   ▼
Lambda  →  API Gateway  →  Browser
```

The Gemini API key **never appears in frontend code**. It lives exclusively
inside Lambda's encrypted environment variables.

---

## Prerequisites

- An AWS account (free tier is sufficient)
- A Google AI Studio API key — get one free at https://aistudio.google.com/app/apikey
- AWS CLI installed and configured  (optional but helpful)

---

## Part 1 — Deploy the Lambda Function

### 1.1  Package the function

```bash
cd backend/lambda

# No npm dependencies needed — uses Node's built-in https module
zip function.zip focusMode.js
```

### 1.2  Create the Lambda function in AWS Console

1. Go to **AWS Console → Lambda → Create function**
2. Choose **Author from scratch**
3. Settings:
   | Field    | Value              |
   |----------|--------------------|
   | Name     | `restart-focus-mode` |
   | Runtime  | Node.js 20.x       |
   | Arch     | x86_64             |
4. Click **Create function**
5. In the **Code** tab → **Upload from** → **.zip file** → upload `function.zip`
6. Set the handler to: `focusMode.handler`

### 1.3  Set the environment variable

1. Go to **Configuration → Environment variables → Edit**
2. Add variable:
   | Key              | Value                    |
   |------------------|--------------------------|
   | `GEMINI_API_KEY` | `your-actual-api-key`    |
3. Optionally add:
   | Key              | Value                                              |
   |------------------|----------------------------------------------------|
   | `ALLOWED_ORIGIN` | `https://your-bucket.s3-website.amazonaws.com`     |
4. Click **Save**

### 1.4  Increase the timeout

Gemini can take 3–8 seconds on the free tier.

1. **Configuration → General configuration → Edit**
2. Set **Timeout** to **15 seconds**
3. Save

---

## Part 2 — Create the API Gateway

### 2.1  Create a new HTTP API

1. Go to **AWS Console → API Gateway → Create API**
2. Choose **HTTP API** (simpler and cheaper than REST API)
3. Click **Add integration** → Lambda → select `restart-focus-mode`
4. API name: `restart-api`
5. Click **Next**

### 2.2  Configure the route

- Method: `POST`
- Resource path: `/focus-mode`
- Integration target: `restart-focus-mode` Lambda

Also add an `OPTIONS` route for CORS pre-flight:
- Method: `OPTIONS`
- Resource path: `/focus-mode`
- Same Lambda integration

### 2.3  Enable CORS

1. In your API → **CORS → Configure**
2. Set:
   | Setting           | Value                                            |
   |-------------------|--------------------------------------------------|
   | Allow origins     | `https://your-s3-bucket-url` (or `*` for dev)   |
   | Allow methods     | `POST, OPTIONS`                                  |
   | Allow headers     | `Content-Type`                                   |
3. Save

### 2.4  Deploy the API

1. **Deploy → Create a new stage** → name it `prod`
2. Click **Deploy**
3. Copy the **Invoke URL** — it looks like:
   ```
   https://abc123xyz.execute-api.us-east-1.amazonaws.com
   ```

---

## Part 3 — Update the Frontend

Open `frontend/script.js` and replace:

```js
const API_BASE = "";
```

with:

```js
const API_BASE = "https://abc123xyz.execute-api.us-east-1.amazonaws.com";
```

Save the file.

---

## Part 4 — Host the Frontend on S3

### 4.1  Create the S3 bucket

1. **AWS Console → S3 → Create bucket**
2. Bucket name: `restart-app` (must be globally unique — add your initials)
3. Region: same as your Lambda function
4. **Uncheck** "Block all public access" (required for static hosting)
5. Acknowledge the warning → Create

### 4.2  Enable static website hosting

1. Open your bucket → **Properties**
2. Scroll to **Static website hosting → Edit**
3. Enable it
4. Index document: `index.html`
5. Save
6. Note the **Bucket website endpoint** URL

### 4.3  Add a bucket policy for public read

Go to **Permissions → Bucket policy** and paste:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::YOUR-BUCKET-NAME/*"
    }
  ]
}
```

Replace `YOUR-BUCKET-NAME` with your actual bucket name.

### 4.4  Upload the frontend files

Upload everything inside the `frontend/` folder:

```bash
# Using AWS CLI
aws s3 sync frontend/ s3://your-bucket-name/ --delete
```

Or drag-and-drop in the S3 console. The bucket should contain:

```
index.html
style.css
script.js
data/
  facts.js
  activities.js
  tips.js
  puzzles.js
```

### 4.5  Update CORS and ALLOWED_ORIGIN

1. Copy the S3 website endpoint URL (e.g. `http://restart-app.s3-website-us-east-1.amazonaws.com`)
2. Update `ALLOWED_ORIGIN` in Lambda environment variables to this URL
3. Update the API Gateway CORS **Allow origins** to this URL

---

## Part 5 — (Optional) Add HTTPS with CloudFront

S3 static websites use HTTP. For HTTPS:

1. **AWS Console → CloudFront → Create distribution**
2. Origin domain: your S3 website endpoint
3. Viewer protocol policy: **Redirect HTTP to HTTPS**
4. Create distribution
5. Use the CloudFront domain (`https://xxxx.cloudfront.net`) as your frontend URL
6. Update `ALLOWED_ORIGIN` in Lambda and API Gateway CORS to the CloudFront URL

---

## Local Development

All features except AI Focus Mode work without any backend:

```bash
# Just open the frontend folder in a browser
# Option 1: double-click frontend/index.html
# Option 2: use a local server
npx serve frontend
# or
python3 -m http.server 8080 --directory frontend
```

When `API_BASE` is empty, clicking "Start Focus Mode" shows a friendly
configuration message instead of an error.

---

## Security Notes

| Concern | How it's handled |
|---|---|
| API key exposure | Key stored only in Lambda env vars, never in frontend |
| Input abuse | Topic capped at 120 characters in Lambda before reaching Gemini |
| Error leakage | Lambda logs full errors to CloudWatch; returns sanitised messages to client |
| CORS | Restricted to your frontend domain via `ALLOWED_ORIGIN` |
| XSS from AI output | Frontend runs `escHtml()` on all Gemini-generated text before inserting into DOM |

---

## Cost Estimate (AWS Free Tier)

| Service      | Free tier                        | Expected usage      |
|--------------|----------------------------------|---------------------|
| Lambda       | 1M requests/month, 400K GB-s     | Well within free    |
| API Gateway  | 1M HTTP API calls/month          | Well within free    |
| S3           | 5 GB storage, 20K GET requests   | Well within free    |
| Gemini 2.5 Flash | Generous free quota          | Free for personal use |

For a personal student tool, this will cost **$0/month**.

## Author

Sapun Jyoti Gogoi
