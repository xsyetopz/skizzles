# Safety

## Use the Moderation API

OpenAI's [Moderation API](https://developers.openai.com/api/docs/guides/moderation) is free to use and can help reduce unsafe content in model outputs. You can also build a content-filtering system tailored to your use case.

If your application generates text with the Responses API or Chat Completions,
you can also [request moderation scores in the generation
request](https://developers.openai.com/api/docs/guides/moderation#moderate-generated-content).

## Test adversarial inputs

Red-team your application to test its resilience to adversarial input. Cover representative inputs and user behavior as well as deliberate attempts to break or redirect the application, including prompt injections.

## Keep a human in the loop

Wherever possible, have a human review outputs before they are used. Human review is especially important in high-stakes domains and for code generation. Reviewers should understand the system's limitations and have the source material needed to verify outputs. For example, someone reviewing a summary should be able to consult the original notes.

## Constrain behavior with prompts

Prompts can constrain the topic and tone of model outputs, reducing the chance of undesired content. Add relevant context and a few high-quality examples of the desired behavior when they help the model follow those constraints.

## Know your customer

Generally, require users to register and log in. Linking access to an existing account may help, although it is not appropriate for every use case. Requiring a payment method or identity verification can reduce risk further.

## Constrain input and output

Limiting input length can reduce the prompt-injection surface. Limiting output tokens can reduce opportunities for misuse.

Narrowing the range of inputs and outputs, especially to trusted sources, reduces the application's misuse surface.

Validated fields, such as a dropdown containing a known list of movies, can be safer than open-ended text input.

When possible, return material from a validated backend source instead of generating novel content. For example, route a customer query to the best matching support article rather than answering it from scratch.

## Let users report issues

Provide an easy way to report improper behavior or other concerns, such as a monitored email address or ticket form. Ensure a person reviews and responds to those reports.

## Understand and communicate limitations

Language models can produce inaccurate, offensive, or biased outputs and may not suit every use case without substantial safeguards. Confirm that the model fits your purpose and evaluate it across the inputs your customers are likely to provide, including cases where performance may degrade. Set user expectations accordingly.

If you notice any safety or security issues while developing with the API or anything else related to OpenAI, please submit it through our [Coordinated Vulnerability Disclosure Program](https://openai.com/security/disclosure/).

## Implement safety identifiers

Sending safety identifiers in requests can help OpenAI detect abuse and provide your team with more actionable feedback about policy violations in your application.

Safety identifiers can also help your team respond to abuse faster. They create a stable way to trace activity back to an individual end user and reduce the chance that one user's misuse disrupts access for your broader organization.

A safety identifier should uniquely identify each user without exposing personal information. Hash the username or email address before sending it. For previews available to users who are not logged in, send a session ID instead.

Safety identifiers are recommended for products where individual users interact
with a model, but they are not required. Include safety identifiers in your API
requests with the `safety_identifier` parameter:

Example: Providing a safety identifier

```python
from openai import OpenAI
client = OpenAI()

response = client.chat.completions.create(
model="gpt-5.6",
messages=[
{"role": "user", "content": "This is a test"}
],
max_completion_tokens=5,
safety_identifier="user_123456"
)
```

```bash
curl https://api.openai.com/v1/chat/completions \
-H "Content-Type: application/json" \
-H "Authorization: Bearer $OPENAI_API_KEY" \
-d '{
"model": "gpt-5.6",
"messages": [
{"role": "user", "content": "This is a test"}
],
"max_completion_tokens": 5,
"safety_identifier": "user123456"
}'
```

For Realtime API requests, provide the same stable, privacy-preserving identifier
with the `OpenAI-Safety-Identifier` header. When you create an ephemeral Realtime
client secret, include the header on the server-side request that creates the
secret so the identifier is bound to that session. For direct WebSocket or WebRTC
connection requests made from a trusted backend, include the header on the
connection request.

Safety identifiers do not carry over between APIs or sessions. If your
application already sends `safety_identifier` with Responses API requests, pass
the same stable value separately when you create or connect each Realtime
session.

## Revoke compromised API keys

If you believe an API key has been exposed, misused, or otherwise compromised,
revoke it promptly and replace it with a new key. Go to your [Security
settings](https://platform.openai.com/settings/profile/security) to view all API
keys and revoke any compromised keys.
