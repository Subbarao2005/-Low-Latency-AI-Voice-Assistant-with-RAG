# Voice Assistant Demo Knowledge Base

## About the Assistant
This is a real-time AI voice assistant designed to answer questions using a retrieval-augmented knowledge base.

## How the Assistant Works
The browser captures microphone audio and sends speech for transcription. The user's query is embedded and matched against relevant knowledge-base content stored in Qdrant. The retrieved context is provided to the language model, which generates the answer. The response can then be converted into speech for the user.

## Supported Features
The assistant supports real-time voice interaction, knowledge-base retrieval, conversational memory, streaming responses, and optional lead capture or CRM actions.

## Knowledge Retrieval
The assistant retrieves the most relevant knowledge-base chunks before generating an answer. The system is designed to keep retrieved context compact so responses remain fast.

## Lead Capture
When enabled, the assistant can capture lead information such as a user's name, email address, company, or other requested details and send that information to a configured CRM webhook.

## Privacy
Users should avoid sharing passwords, API keys, payment card information, or other sensitive credentials with the assistant.
