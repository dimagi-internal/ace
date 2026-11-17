def main(input: str, **kwargs) -> str:
    # ACE Coach status node (OCS Python node). Generalised from the KMC Audit bot.
    #
    # Strips the coach's system markers out of the reply and turns them into
    # participant data Labs already reads:
    #   chatbot_task_status   initiated -> in_progress -> completed (monotonic)
    #   chatbot_topics_done   list of topic keys (deduplicated)
    # plus ACE's richer record:
    #   chatbot_topics        list of {key, agreement, cause, owner, plan, by, note}
    #   chatbot_review_needed true when any topic is disputed or the coach escalated
    #   chatbot_escalations   list of escalation categories
    # Every list is reset when a new session (a new task) starts.
    #
    # Optional briefing picture: when Labs starts the session with `coach_image_url`
    # (a short-lived signed link to a chart of THIS worker's own figures) in the
    # session data, the picture rides on the coach's first reply, once. Without it
    # nothing changes. The fetch authenticates with the team's `connect-labs` Auth
    # Provider (a Labs bearer token), so the link alone cannot fetch the image.
    # A failed fetch never blocks the reply: it is recorded for staff in
    # session state `coach_image_error` and the reply goes out as text.
    #
    # Optional case CARD (card-html): a case conversation also carries
    # `coach_card_url` (one case as a phone-sized page, Labs' coach_charts/case_card.py)
    # and `coach_card_call` (a Markdown tap-to-call line). With SEND_CARDS on, the card's
    # index.html rides on the first reply INSTEAD of the picture, and the call line is
    # added to that reply's text (a card cannot dial). If the card cannot be fetched the
    # picture goes as before. Keep SEND_CARDS off until Open Chat Studio marks a reply
    # as `format: card-html` for Connect: before that an index.html reaches the worker
    # as a bare file, which is worse than the picture.
    SEND_CARDS = False

    participant_data = get_participant_data() or {}
    status = participant_data.get("chatbot_task_status", "")
    user_input = (get_temp_state_key("user_input") or "").strip()
    opening_turn = not get_session_state_key("chatbot_task_status")

    if opening_turn:
        status = ""
        participant_data["chatbot_topics_done"] = []
        participant_data["chatbot_topics"] = []
        participant_data["chatbot_review_needed"] = False
        participant_data["chatbot_escalations"] = []

    reply = input or ""

    def take(prefix, text):
        found = []
        while prefix in text:
            start = text.index(prefix)
            end = text.find("]]", start)
            if end == -1:
                # Malformed: leave the text alone rather than guess where it ends.
                break
            found.append(text[start + len(prefix):end].strip())
            text = text[:start] + text[end + 2:]
        return found, text

    topic_bodies, reply = take("[[COACH_TOPIC:", reply)
    escalations, reply = take("[[COACH_ESCALATE:", reply)
    all_finished = "[[COACH_DONE]]" in reply
    reply = reply.replace("[[COACH_DONE]]", "")
    # A marker the model wrapped in backticks leaves an empty code span behind
    # (ace#2744); remove those, and any line left holding only backticks.
    reply = reply.replace("``", "")
    reply = "\n".join(line for line in reply.split("\n") if line.strip() not in ("`", "```"))
    # Tidy blank lines a removed marker leaves behind.
    while "\n\n\n" in reply:
        reply = reply.replace("\n\n\n", "\n\n")
    reply = reply.strip()

    topics = list(participant_data.get("chatbot_topics") or [])
    done = list(participant_data.get("chatbot_topics_done") or [])
    for body in topic_bodies:
        parts = body.split("|")
        record = {"key": parts[0].strip()}
        for part in parts[1:]:
            if "=" in part:
                name, value = part.split("=", 1)
                record[name.strip()] = value.strip()
        if not record["key"]:
            continue
        # One record per key: a later close of the same topic replaces the earlier one.
        topics = [t for t in topics if t.get("key") != record["key"]] + [record]
        if record["key"] not in done:
            done.append(record["key"])

    review_needed = bool(participant_data.get("chatbot_review_needed"))
    if any(t.get("agreement") in ("disputed", "partial") for t in topics):
        review_needed = True
    esc = list(participant_data.get("chatbot_escalations") or [])
    for category in escalations:
        if category and category not in esc:
            esc.append(category)
    if esc:
        review_needed = True

    RANK = {"": 0, "not_started": 1, "initiated": 2, "in_progress": 3, "completed": 4}
    if all_finished:
        new_status = "completed"
    elif opening_turn:
        new_status = "initiated"
    elif user_input or topic_bodies:
        new_status = "in_progress"
    else:
        new_status = status
    if RANK.get(new_status, 0) > RANK.get(status, 0):
        status = new_status

    participant_data["chatbot_task_status"] = status
    participant_data["chatbot_topics"] = topics
    participant_data["chatbot_topics_done"] = done
    participant_data["chatbot_review_needed"] = review_needed
    participant_data["chatbot_escalations"] = esc
    set_participant_data(participant_data)

    set_session_state_key("chatbot_task_status", status)
    set_session_state_key("chatbot_review_needed", review_needed)

    image_url = get_session_state_key("coach_image_url")
    card_url = get_session_state_key("coach_card_url") if SEND_CARDS else None
    if (image_url or card_url) and user_input and not get_session_state_key("coach_image_sent"):
        # Mark it sent before fetching: one attempt per session, so a slow or broken
        # image endpoint costs the worker one delay at most, never one per turn.
        set_session_state_key("coach_image_sent", True)
        sent_card = False
        if card_url:
            try:
                response = http.get(card_url, auth="connect-labs", timeout=20)
                content_type = (response["headers"].get("content-type") or "").split(";")[0].strip()
                if response["status_code"] == 200 and response["content"] and content_type == "text/html":
                    add_file_attachment("index.html", response["content"], "text/html")
                    sent_card = True
                    try:
                        # The explicit card signal, if this OCS has one; without it OCS
                        # marks a reply whose files include index.html as a card.
                        set_message_format("card-html")
                    except NameError:
                        pass
                    call = (get_session_state_key("coach_card_call") or "").strip()
                    if call:
                        reply = (reply + "\n\n" + call).strip()
                else:
                    set_session_state_key(
                        "coach_card_error", "HTTP %s, %s" % (response["status_code"], content_type or "no content type")
                    )
            except Exception as error:
                set_session_state_key("coach_card_error", str(error)[:300])
        if sent_card:
            image_url = None  # the card carries the picture's case; never both
    else:
        image_url = None  # not this turn: nothing to fetch
    if image_url:
        try:
            response = http.get(image_url, auth="connect-labs", timeout=20)
            content_type = (response["headers"].get("content-type") or "").split(";")[0].strip()
            if response["status_code"] == 200 and response["content"] and content_type.startswith("image/"):
                extension = content_type.split("/", 1)[1] or "png"
                add_file_attachment("your-progress." + extension, response["content"], content_type)
            else:
                set_session_state_key(
                    "coach_image_error", "HTTP %s, %s" % (response["status_code"], content_type or "no content type")
                )
        except Exception as error:
            set_session_state_key("coach_image_error", str(error)[:300])
    return reply
